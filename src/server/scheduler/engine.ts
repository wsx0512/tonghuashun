/**
 * 任务状态机与调度引擎。
 *
 * 承担题目第 2 条要求的六件事：
 *   调度 · 状态 · 去重 · 冷却 · 恢复 · 版本变化
 *
 * 关键不变量：
 *   - 去重靠 triggers.dedup_key 主键 + INSERT OR IGNORE，**跨进程重启**依然成立
 *   - 调度幂等靠 runs(task_id, slot_key) 唯一
 *   - 冷却期内条件继续评估但抑制通知，被抑制的次数**可见**，不是静默丢弃
 *   - unknown 一律进 DEGRADED，绝不塌缩为"未触发"
 *   - 补算结果标记为 backfilled，与实时触发在 UI 上区分
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  MonitorTask,
  TaskState,
  Truth,
  ReasonCode,
  Condition,
} from '../../shared/dsl/types.js';
import { canonicalParams, resolveDataNeeds, mergeAcrossTasks } from '../domain/dataNeeds.js';
import { subjectCode } from '../../shared/dsl/types.js';
import { evaluateRule, type DataBundle, type TaskEvaluation } from '../domain/evaluate.js';
import { SourceMesh, type FieldComparison } from '../sources/sourceMesh.js';
import * as repo from '../store/repo.js';
import { newId } from '../store/db.js';

export interface EngineDeps {
  db: DatabaseSync;
  mesh: SourceMesh;
  now: () => number;
  subjectName: (thscode: string) => string;
  /** 交易日判定；返回 null 表示日历未就绪 */
  isTradingDay: (dateCompact: string) => boolean | null;
}

export interface RunResult {
  taskId: string;
  runId: string | null;
  skipped: boolean;
  skipReason?: string;
  truth?: Truth;
  reasonCode?: ReasonCode;
  stateBefore?: TaskState;
  stateAfter?: TaskState;
  notifications: { id: string; kind: string; text: string; epistemic: string }[];
  suppressedCount: number;
  evaluation?: TaskEvaluation;
}

// ────────────────────────── 冷却与去重键 ──────────────────────────

/**
 * 去重分桶键 —— **按条件类型分桶，与冷却时长无关**。
 *
 * 这两个概念必须解耦，各管一件事：
 *   - 去重桶：同一条件在同一个桶内最多通知一次（价格/热度/事件按自然日，
 *     日历类按月 —— 日历条件每个交易日都会命中，按日会把用户淹没）
 *   - 冷却：一次通知之后，至少间隔多久才允许下一次
 *
 * 早先的写法把分桶键也从 policy.cooldown 推导，导致两者粒度永远相同，
 * 冷却分支实际成了死代码（永远被去重抢先）。测试抓到了这个问题。
 */
export function computeBucketKey(leafKind: 'price' | 'event' | 'heat' | 'calendar', now: number): string {
  const d = new Date(now + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (leafKind === 'calendar') return `m${y}${mo}`;
  return `d${y}${mo}${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function computeDedupKey(args: {
  taskId: string;
  ruleVersionId: string;
  leafId: string;
  subjectThscode: string;
  bucketKey: string;
}): string {
  return `${args.taskId}|${args.ruleVersionId}|${args.leafId}|${args.subjectThscode}|${args.bucketKey}`;
}

/** 冷却时长（毫秒） */
export function cooldownMs(task: MonitorTask): number {
  const c = task.policy.cooldown;
  switch (c.kind) {
    case 'trading_day':
      return 24 * 3600_000;
    case 'hours':
      return c.value * 3600_000;
    case 'ms':
      return c.value;
  }
}

// ────────────────────────── 评估一次任务 ──────────────────────────

export async function runTask(
  deps: EngineDeps,
  task: MonitorTask,
  opts: { force?: boolean; backfilled?: boolean } = {},
): Promise<RunResult> {
  const { db } = deps;
  const now = deps.now();

  const rule = repo.getRuleDocument(db, task.activeRuleVersionId);
  if (!rule) {
    return {
      taskId: task.id,
      runId: null,
      skipped: true,
      skipReason: `规则版本 ${task.activeRuleVersionId} 不存在`,
      notifications: [],
      suppressedCount: 0,
    };
  }

  // ── 调度幂等：同一时间槽只评估一次 ──
  const granularity = task.schedule.kind === 'interval' ? Math.max(1000, task.schedule.everyMs) : 60_000;
  const slotKey = opts.force ? `force_${now}` : String(Math.floor(now / granularity));
  const runId = repo.claimSlot(db, task.id, slotKey, rule.id, now, opts.backfilled ?? false);
  if (!runId) {
    return {
      taskId: task.id,
      runId: null,
      skipped: true,
      skipReason: `时间槽 ${slotKey} 已评估过（调度幂等）`,
      notifications: [],
      suppressedCount: 0,
    };
  }

  const stateBefore = task.state;

  try {
    // ── 取数 ──
    const needs = resolveDataNeeds(rule.root);
    const bundle: DataBundle = new Map();
    const allConflicts: FieldComparison[] = [];

    for (const need of needs) {
      const key = `${need.endpoint}?${canonicalParams(need.params)}`;
      if (bundle.has(key)) continue;
      const outcome = await deps.mesh.fetch({ endpoint: need.endpoint, params: need.params });
      bundle.set(key, { endpoint: need.endpoint, params: need.params, result: outcome.primary });
      allConflicts.push(...outcome.conflicts);

      // 留痕原始响应，供证据回链
      const raw = outcome.primary.raw;
      repo.saveRawResponse(db, {
        id: raw.id,
        provider: raw.provider,
        endpoint: raw.endpoint,
        params: raw.requestParams,
        httpStatus: raw.httpStatus,
        code: outcome.primary.ok ? 0 : errorCodeOf(outcome.primary),
        requestId: raw.id,
        body: raw.body,
        retrievedAt: raw.retrievedAt,
        mode: raw.mode,
      });
    }

    // ── 求值 ──
    const evaluation = evaluateRule({
      root: rule.root,
      taskId: task.id,
      ruleVersionId: rule.id,
      runId,
      bundle,
      conflicts: allConflicts,
      now,
      subjectName: deps.subjectName,
    });

    // 落证据
    for (const leaf of evaluation.leaves) {
      repo.saveEvidence(db, {
        id: leaf.evidence.evidenceId,
        taskId: task.id,
        runId,
        ruleVersionId: rule.id,
        leafId: leaf.leafId,
        payload: leaf.evidence,
        now,
      });
    }

    // ── 去重 / 冷却 / 通知 ──
    const notifications: RunResult['notifications'] = [];
    let suppressedCount = 0;
    const inCooldown = task.cooldownUntil !== null && now < task.cooldownUntil;

    for (const leaf of evaluation.leaves) {
      const bucketKey = computeBucketKey(leaf.kind, now);
      const rrt = repo.getConditionRuntime(db, task.id, leaf.leafId);
      const wasTrue = rrt?.last_value === 'true';
      repo.upsertConditionRuntime(db, { taskId: task.id, leafId: leaf.leafId, truth: leaf.truth, now });

      if (leaf.truth !== true) {
        // 恢复通知：此前为真、现在为假
        if (wasTrue && task.policy.notifyOnRecovery) {
          const text = `此前触发的条件已解除（${leaf.evidence.conditionKind}，规则版本 v${rule.version}）。`;
          const id = repo.addNotification(db, {
            taskId: task.id,
            runId,
            kind: 'RECOVERED',
            text,
            epistemic: 'fact',
            now,
          });
          notifications.push({ id, kind: 'RECOVERED', text, epistemic: 'fact' });
        }
        continue;
      }

      // edge 模式：条件需从 false 回到 true 才再次触发
      if (task.policy.triggerMode === 'edge' && wasTrue) {
        repo.recordSuppressed(db, {
          taskId: task.id,
          leafId: leaf.leafId,
          dedupKey: `edge:${leaf.leafId}`,
          reason: 'edge 模式：条件持续为真，未回到 false',
          now,
        });
        suppressedCount++;
        continue;
      }

      const subjectThscode = extractSubject(rule.root, leaf.leafId) ?? '';
      const dedupKey = computeDedupKey({
        taskId: task.id,
        ruleVersionId: rule.id,
        leafId: leaf.leafId,
        subjectThscode,
        bucketKey,
      });

      const claimed = repo.claimTrigger(db, {
        dedupKey,
        taskId: task.id,
        runId,
        leafId: leaf.leafId,
        subjectThscode,
        bucketKey,
        now,
      });

      if (!claimed) {
        // 同桶内已触发过 → 去重抑制（留痕，非静默丢弃）
        repo.recordSuppressed(db, {
          taskId: task.id,
          leafId: leaf.leafId,
          dedupKey,
          reason: `去重：同一时间桶 ${bucketKey} 内已触发过`,
          now,
        });
        suppressedCount++;
        continue;
      }

      if (inCooldown) {
        // 冷却期内：条件仍评估，但通知被抑制并计数
        repo.recordSuppressed(db, {
          taskId: task.id,
          leafId: leaf.leafId,
          dedupKey,
          reason: `冷却中（至 ${new Date(task.cooldownUntil!).toISOString()}），本会触发`,
          now,
        });
        suppressedCount++;
        continue;
      }

      const id = repo.addNotification(db, {
        taskId: task.id,
        runId,
        kind: 'TRIGGERED',
        text: leaf.evidence.narrative,
        epistemic: 'fact',
        now,
      });
      notifications.push({ id, kind: 'TRIGGERED', text: leaf.evidence.narrative, epistemic: 'fact' });
    }

    // ── 状态转移 ──
    const health = { ...task.health, lastEvaluatedAt: now, lastReasonCode: evaluation.reasonCode };
    let stateAfter: TaskState = stateBefore;
    let cooldownUntil = task.cooldownUntil;

    if (evaluation.truth === 'unknown') {
      health.consecutiveFailures =
        evaluation.reasonCode === 'FAILURE' || evaluation.reasonCode === 'RATE_LIMITED'
          ? task.health.consecutiveFailures + 1
          : 0;
      health.degradedSince = task.health.degradedSince ?? now;

      if (health.consecutiveFailures >= task.policy.maxConsecutiveFailures) {
        stateAfter = 'FAILED';
      } else {
        stateAfter = 'DEGRADED';
      }
    } else {
      health.consecutiveFailures = 0;
      const recoveredFrom = task.health.degradedSince;
      health.degradedSince = null;

      if (notifications.some((n) => n.kind === 'TRIGGERED')) {
        stateAfter = 'COOLDOWN';
        cooldownUntil = now + cooldownMs(task);
      } else if (recoveredFrom !== null && stateBefore === 'DEGRADED') {
        // 健康级恢复通知
        const mins = Math.round((now - recoveredFrom) / 60000);
        const text = `数据已恢复，任务从降级状态回到正常监控（此前降级约 ${mins} 分钟）。`;
        const id = repo.addNotification(db, {
          taskId: task.id,
          runId,
          kind: 'HEALTH_RECOVERED',
          text,
          epistemic: 'fact',
          now,
        });
        notifications.push({ id, kind: 'HEALTH_RECOVERED', text, epistemic: 'fact' });
        stateAfter = 'RECOVERING';
      } else {
        // 冷却到期且未触发 → 回到常规监控
        stateAfter = task.cooldownUntil !== null && now >= task.cooldownUntil ? 'PENDING' : stateBefore === 'COOLDOWN' ? 'PENDING' : 'PENDING';
        if (task.cooldownUntil !== null && now >= task.cooldownUntil) cooldownUntil = null;
      }
    }

    const nextRunAt = computeNextRunAt(deps, task, now);
    repo.setTaskState(db, task.id, stateAfter, { cooldownUntil, nextRunAt, health });

    if (stateAfter !== stateBefore) {
      repo.logEvent(db, {
        taskId: task.id,
        runId,
        kind: 'STATE_CHANGE',
        from: stateBefore,
        to: stateAfter,
        payload: { reasonCode: evaluation.reasonCode, truth: evaluation.truth },
        now,
      });
    }

    repo.finishRun(db, runId, {
      status: opts.backfilled ? 'backfilled' : 'ok',
      truth: evaluation.truth,
      reasonCode: evaluation.reasonCode,
      narrative: evaluation.narrative,
      finishedAt: deps.now(),
    });

    return {
      taskId: task.id,
      runId,
      skipped: false,
      truth: evaluation.truth,
      reasonCode: evaluation.reasonCode,
      stateBefore,
      stateAfter,
      notifications,
      suppressedCount,
      evaluation,
    };
  } catch (err) {
    repo.finishRun(db, runId, {
      status: 'error',
      reasonCode: 'FAILURE',
      narrative: `评估过程异常：${(err as Error).message}`,
      finishedAt: deps.now(),
    });
    repo.setTaskState(db, task.id, 'FAILED', {
      health: { ...task.health, consecutiveFailures: task.health.consecutiveFailures + 1 },
    });
    throw err;
  }
}

function errorCodeOf(r: { ok: false; message: string }): number | null {
  const m = /code=(\d+)/.exec(r.message);
  return m ? Number(m[1]) : null;
}

/** 从规则树里找出某叶子对应的标的代码，用于去重键 */
function extractSubject(root: Condition, leafId: string): string | null {
  const stack: Condition[] = [root];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.type === 'and' || c.type === 'or') {
      stack.push(...c.children);
    } else if (c.type === 'not') {
      stack.push(c.child);
    } else if (c.id === leafId) {
      if ('subject' in c) return subjectCode(c.subject);
      return null;
    }
  }
  return null;
}

// ────────────────────────── 下次评估时间 ──────────────────────────

export function computeNextRunAt(deps: EngineDeps, task: MonitorTask, now: number): number {
  const s = task.schedule;
  if (s.kind === 'interval') {
    let next = now + s.everyMs;
    if (s.tradingHoursOnly) {
      next = alignToTradingHours(deps, next);
    }
    return next;
  }

  // dailyAt：取下一个尚未到达的时刻
  const times = [...s.times].sort();
  const sh = new Date(now + 8 * 3600 * 1000);
  const today = `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, '0')}-${String(
    sh.getUTCDate(),
  ).padStart(2, '0')}`;

  for (const t of times) {
    const [hh, mm] = t.split(':').map(Number);
    const ts = Date.parse(`${today}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);
    if (ts > now) {
      if (!s.tradingDaysOnly) return ts;
      const compact = today.replace(/-/g, '');
      if (deps.isTradingDay(compact) !== false) return ts;
    }
  }

  // 今日无剩余时刻 → 顺延到明天同一时刻
  let next = Date.parse(`${today}T${times[0]}:00+08:00`) + 24 * 3600_000;
  if (s.tradingDaysOnly) next = rollForwardToTradingDay(deps, next);
  return next;
}

/**
 * 把时间推进到下一个交易时段内的时刻。
 *
 * A 股时段：09:30–11:30、13:00–15:00（Asia/Shanghai）。
 * 位于时段之外或非交易日时，顺延到下一个可用时段的起点。
 */
function alignToTradingHours(deps: EngineDeps, ts: number): number {
  for (let i = 0; i < 15; i++) {
    const sh = new Date(ts + 8 * 3600 * 1000);
    const y = sh.getUTCFullYear();
    const mo = sh.getUTCMonth();
    const d = sh.getUTCDate();
    const dow = sh.getUTCDay();
    const minutes = sh.getUTCHours() * 60 + sh.getUTCMinutes();
    const iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const compact = `${y}${String(mo + 1).padStart(2, '0')}${String(d).padStart(2, '0')}`;

    const trading = deps.isTradingDay(compact);
    const isTradingDay = dow !== 0 && dow !== 6 && trading !== false;

    if (!isTradingDay) {
      // 顺延到次日 09:30
      ts = Date.parse(`${iso}T09:30:00+08:00`) + 24 * 3600_000;
      continue;
    }
    if (minutes < 570) return Date.parse(`${iso}T09:30:00+08:00`); // 开盘前
    if (minutes > 690 && minutes < 780) return Date.parse(`${iso}T13:00:00+08:00`); // 午休
    if (minutes > 900) {
      ts = Date.parse(`${iso}T09:30:00+08:00`) + 24 * 3600_000; // 收盘后
      continue;
    }
    return ts;
  }
  return ts;
}

function rollForwardToTradingDay(deps: EngineDeps, ts: number): number {
  for (let i = 0; i < 15; i++) {
    const sh = new Date(ts + 8 * 3600 * 1000);
    const compact = `${sh.getUTCFullYear()}${String(sh.getUTCMonth() + 1).padStart(2, '0')}${String(
      sh.getUTCDate(),
    ).padStart(2, '0')}`;
    const day = sh.getUTCDay();
    if (day !== 0 && day !== 6 && deps.isTradingDay(compact) !== false) return ts;
    ts += 24 * 3600_000;
  }
  return ts;
}

// ────────────────────────── 批量调度一个 tick ──────────────────────────

export interface TickResult {
  evaluated: number;
  skipped: number;
  degraded: number;
  triggered: number;
  results: RunResult[];
}

export async function tick(deps: EngineDeps): Promise<TickResult> {
  const now = deps.now();
  const due = repo.dueTasks(deps.db, now);
  const results: RunResult[] = [];

  for (const task of due) {
    try {
      results.push(await runTask(deps, task));
    } catch (e) {
      results.push({
        taskId: task.id,
        runId: null,
        skipped: false,
        notifications: [],
        suppressedCount: 0,
        reasonCode: 'FAILURE',
      });
    }
  }

  return {
    evaluated: results.filter((r) => !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    degraded: results.filter((r) => r.truth === 'unknown').length,
    triggered: results.filter((r) => r.notifications.some((n) => n.kind === 'TRIGGERED')).length,
    results,
  };
}
