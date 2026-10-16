/**
 * 状态机测试 —— 对应测试计划 B 组。
 * 覆盖：调度幂等、去重、冷却、恢复、版本变化、冷启动。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../store/db.js';
import * as repo from '../store/repo.js';
import { ReplayAdapter } from '../sources/replay.adapter.js';
import { ChaosAdapter } from '../sources/chaos.adapter.js';
import { SourceMesh } from '../sources/sourceMesh.js';
import { unwrapEnvelope, type SourceResult } from '../sources/envelope.js';
import type { SourceAdapter, SourceRequest } from '../sources/types.js';
import { runTask, computeBucketKey, computeNextRunAt, type EngineDeps } from './engine.js';
import { resetNodeIds, parseNaturalLanguage, type CatalogEntry } from '../nl/parser.js';
import { ManualClock, setClock, resetClock, getClock } from '../clock.js';
import type { DatabaseSync } from 'node:sqlite';
import type { MonitorTask, RuleDocument } from '../../shared/dsl/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog: CatalogEntry[] = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'fixtures', 'catalog.json'), 'utf8'),
).instruments;
const names = new Map(catalog.map((c) => [c.thscode, c.name]));

const T0 = Date.parse('2026-10-15T15:05:00+08:00');

let db: DatabaseSync;
let clock: ManualClock;
let deps: EngineDeps;
let chaos: ChaosAdapter;

beforeEach(() => {
  resetNodeIds();
  db = openDb({ path: ':memory:' });
  clock = new ManualClock(T0);
  setClock(clock);
  chaos = new ChaosAdapter();
  deps = {
    db,
    mesh: new SourceMesh({ primary: chaos }),
    now: () => clock.now(),
    subjectName: (code) => names.get(code) ?? code,
    isTradingDay: (compact) => repo.isTradingDay(db, compact),
  };
  // 载入交易日历
  const fx = JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', 'fixtures', 'fuyao', 'trading_days.json'), 'utf8'),
  );
  repo.replaceCalendar(db, fx.data.item);
});

afterEach(() => {
  resetClock();
  db.close();
});

/** 建一个任务 */
function makeTask(
  text: string,
  opts: {
    id?: string;
    policy?: Partial<MonitorTask['policy']>;
    schedule?: MonitorTask['schedule'];
  } = {},
): MonitorTask {
  const id = opts.id ?? 'task1';
  const parsed = parseNaturalLanguage(text, catalog);
  if (!parsed.ok) throw new Error(`解析失败：${parsed.message}`);

  const rule: RuleDocument = {
    id: `${id}_v1`,
    taskId: id,
    schemaVersion: '1.0.0',
    version: 1,
    createdAt: clock.now(),
    author: 'nl_parser',
    source: { kind: 'nl', rawText: text },
    scope: parsed.scope,
    root: parsed.root,
  };
  repo.insertRuleDocument(db, rule);

  const task: MonitorTask = {
    id,
    name: text,
    activeRuleVersionId: rule.id,
    schedule: opts.schedule ?? { kind: 'interval', everyMs: 60_000, tradingHoursOnly: false },
    policy: {
      triggerMode: 'level',
      cooldown: { kind: 'hours', value: 4 },
      notifyOnRecovery: true,
      maxConsecutiveFailures: 3,
      ...opts.policy,
    },
    state: 'PENDING',
    health: { consecutiveFailures: 0, lastEvaluatedAt: null, lastReasonCode: null, degradedSince: null },
    cooldownUntil: null,
    nextRunAt: clock.now(),
    createdAt: clock.now(),
    updatedAt: clock.now(),
  };
  repo.upsertTask(db, task);
  return task;
}

const getTask = (id = 'task1') => repo.getTask(db, id)!;

/**
 * 桩适配器：让价格可被测试直接控制。
 * 用于验证"条件由真转假"这类需要**数据变化**的场景——
 * 规则版本变化不算数据变化（换了阈值就是换了一个条件，不应发"已解除"）。
 */
class StubPriceAdapter implements SourceAdapter {
  readonly name = 'stub';
  readonly mode = 'replay' as const;
  price = 1400;
  private fallback = new ReplayAdapter();

  async fetch<T = unknown>(req: SourceRequest): Promise<SourceResult<T>> {
    if (req.endpoint === '/api/a-share/prices/snapshot') {
      const thscodes = (req.params.thscodes ?? '600519.SH').split(',');
      const body = {
        code: 0,
        message: 'success',
        request_id: 'stub_req_1',
        data: {
          timestamp: getClock().now(),
          item: thscodes.map((t) => ({
            thscode: t.trim(),
            ticker: t.trim().split('.')[0],
            last_price: this.price,
            price_change_ratio_pct: 1,
          })),
        },
      };
      return unwrapEnvelope<T>(
        { httpStatus: 200, body },
        { provider: 'stub', endpoint: req.endpoint, requestParams: req.params, mode: 'replay' },
      );
    }
    return this.fallback.fetch<T>(req);
  }
}

describe('调度幂等', () => {
  it('同一时间槽重复调用只评估一次', async () => {
    makeTask('崇达技术出现涨停');
    const a = await runTask(deps, getTask());
    const b = await runTask(deps, getTask()); // 时钟未推进 → 同一槽位
    expect(a.skipped).toBe(false);
    expect(b.skipped).toBe(true);
    expect(b.skipReason).toContain('调度幂等');
  });

  it('时钟推进后可以再次评估', async () => {
    makeTask('崇达技术出现涨停');
    await runTask(deps, getTask());
    clock.advance(5 * 60_000);
    const b = await runTask(deps, getTask());
    expect(b.skipped).toBe(false);
  });

  it('TC-B7: 冷启动把中断的 run 标记为 interrupted', () => {
    makeTask('崇达技术出现涨停');
    // 手工插一条"评估中"的残留记录
    db.prepare(
      `INSERT INTO runs (id,task_id,slot_key,rule_version_id,started_at,status,backfilled)
       VALUES ('stale','task1','slotX','task1_v1',?,'evaluating',0)`,
    ).run(clock.now());
    const n = repo.markInterruptedRuns(db, clock.now());
    expect(n).toBe(1);
    const r = db.prepare("SELECT status FROM runs WHERE id='stale'").get() as any;
    expect(r.status).toBe('interrupted');
  });
});

describe('TC-B1: 去重', () => {
  it('同一时间桶内二次命中被抑制，且不产生第二条通知', async () => {
    // 用 trading_day 桶：同一天内只触发一次
    makeTask('崇达技术出现涨停', { policy: { cooldown: { kind: 'trading_day', value: 1 } } });

    const first = await runTask(deps, getTask());
    expect(first.notifications.filter((n) => n.kind === 'TRIGGERED')).toHaveLength(1);

    // 推进 5 分钟（仍在同一交易日桶内），并清掉冷却以便单独验证去重
    clock.advance(5 * 60_000);
    repo.setTaskState(db, 'task1', 'PENDING', { cooldownUntil: null });

    const second = await runTask(deps, getTask());
    expect(second.notifications.filter((n) => n.kind === 'TRIGGERED')).toHaveLength(0);
    expect(second.suppressedCount).toBeGreaterThan(0);

    // 抑制被留痕，不是静默丢弃
    const sup = repo.listSuppressed(db, 'task1');
    expect(sup.length).toBeGreaterThan(0);
    expect(sup[0]!.reason).toContain('去重');
  });

  it('跨桶可以再次触发', async () => {
    makeTask('崇达技术出现涨停', { policy: { cooldown: { kind: 'hours', value: 1 } } });
    await runTask(deps, getTask());
    clock.advance(25 * 3600_000); // 次日 → 新的日桶，且冷却（1 小时）已过
    repo.setTaskState(db, 'task1', 'PENDING', { cooldownUntil: null, nextRunAt: clock.now() });
    const b = await runTask(deps, getTask());
    expect(b.notifications.filter((n) => n.kind === 'TRIGGERED')).toHaveLength(1);
  });

  it('bucketKey 按条件类型分桶，与冷却时长无关', () => {
    expect(computeBucketKey('price', T0)).toBe(computeBucketKey('price', T0 + 3600_000)); // 同一天
    expect(computeBucketKey('price', T0)).not.toBe(computeBucketKey('price', T0 + 24 * 3600_000));
    // 日历类按月分桶（每个交易日都命中，按日会淹没用户）
    expect(computeBucketKey('calendar', T0)).toBe(computeBucketKey('calendar', T0 + 5 * 24 * 3600_000));
    expect(computeBucketKey('price', T0)).not.toBe(computeBucketKey('calendar', T0));
  });
});

describe('冷却', () => {
  it('触发后进入 COOLDOWN 并设置 cooldownUntil', async () => {
    makeTask('崇达技术出现涨停');
    const r = await runTask(deps, getTask());
    expect(r.stateAfter).toBe('COOLDOWN');
    expect(getTask().cooldownUntil).toBeGreaterThan(clock.now());
  });

  it('冷却期内条件为真 → 通知被抑制并计数（用户能看到"本会触发"）', async () => {
    // 冷却需跨过多个分桶日，"冷却"才会先于"去重"成为真正原因
    makeTask('崇达技术出现涨停', { policy: { cooldown: { kind: 'hours', value: 48 } } });
    await runTask(deps, getTask());

    clock.advance(24 * 3600_000); // 次日：新的分桶，但仍在冷却期内
    repo.setTaskState(db, 'task1', 'PENDING', { nextRunAt: clock.now() });
    const r2 = await runTask(deps, getTask());

    expect(r2.notifications.filter((n) => n.kind === 'TRIGGERED')).toHaveLength(0);
    expect(r2.suppressedCount).toBeGreaterThan(0);
    const sup = repo.listSuppressed(db, 'task1');
    expect(sup.some((x) => String(x.reason).includes('冷却中'))).toBe(true);
  });

  it('冷却到期后恢复正常监控', async () => {
    makeTask('崇达技术出现涨停', { policy: { cooldown: { kind: 'ms', value: 60_000 } } });
    await runTask(deps, getTask());
    clock.advance(61_000);
    repo.setTaskState(db, 'task1', 'PENDING', { cooldownUntil: null });
    const r = await runTask(deps, getTask());
    expect(r.truth).toBe(true);
  });
});

describe('TC-B3: edge 模式（条件需回到 false 才再触发）', () => {
  it('条件持续为真时不重复通知', async () => {
    makeTask('崇达技术出现涨停', {
      policy: { triggerMode: 'edge', cooldown: { kind: 'ms', value: 1000 } },
    });

    const first = await runTask(deps, getTask());
    expect(first.notifications.filter((n) => n.kind === 'TRIGGERED')).toHaveLength(1);

    clock.advance(120_000);
    repo.setTaskState(db, 'task1', 'PENDING', { cooldownUntil: null });
    const second = await runTask(deps, getTask());

    expect(second.notifications.filter((n) => n.kind === 'TRIGGERED')).toHaveLength(0);
    const sup = repo.listSuppressed(db, 'task1');
    expect(sup.some((s) => String(s.reason).includes('edge'))).toBe(true);
  });
});

describe('TC-B5: 恢复通知', () => {
  it('条件由真转假 → 发出"条件已解除"通知', async () => {
    // 用桩数据源直接控制价格，这样"转假"来自**数据变化**而非规则变化
    const stub = new StubPriceAdapter();
    stub.price = 1400;
    const depsStub: EngineDeps = { ...deps, mesh: new SourceMesh({ primary: stub }) };

    makeTask('贵州茅台股价高于1300元', { policy: { cooldown: { kind: 'ms', value: 1000 } } });
    const first = await runTask(depsStub, getTask());
    expect(first.truth).toBe(true);
    expect(first.notifications.some((n) => n.kind === 'TRIGGERED')).toBe(true);

    // 价格跌破阈值 → 条件转假
    stub.price = 1200;
    clock.advance(120_000);
    repo.setTaskState(db, 'task1', 'PENDING', { cooldownUntil: null, nextRunAt: clock.now() });
    const second = await runTask(depsStub, getTask());

    expect(second.truth).toBe(false);
    expect(second.notifications.some((n) => n.kind === 'RECOVERED')).toBe(true);
    expect(second.notifications.find((n) => n.kind === 'RECOVERED')!.text).toContain('已解除');
  });

  it('改规则版本不应触发"条件已解除"（换了阈值就是另一个条件）', async () => {
    const stub = new StubPriceAdapter();
    stub.price = 1400;
    const depsStub: EngineDeps = { ...deps, mesh: new SourceMesh({ primary: stub }) };

    const t = makeTask('贵州茅台股价高于1300元', { policy: { cooldown: { kind: 'ms', value: 1000 } } });
    await runTask(depsStub, t);

    // 只改规则（阈值 1300 → 9999），数据不变
    const parsed = parseNaturalLanguage('贵州茅台股价高于9999元', catalog);
    if (!parsed.ok) throw new Error('unreachable');
    const v2: RuleDocument = {
      ...repo.getRuleDocument(db, t.activeRuleVersionId)!,
      id: 'task1_v2',
      version: 2,
      author: 'user',
      root: parsed.root,
    };
    repo.insertRuleDocument(db, v2);
    repo.upsertTask(db, { ...getTask(), activeRuleVersionId: 'task1_v2' });

    clock.advance(120_000);
    repo.setTaskState(db, 'task1', 'PENDING', { cooldownUntil: null, nextRunAt: clock.now() });
    const r = await runTask(depsStub, getTask());

    expect(r.truth).toBe(false);
    // 新版本的条件从未为真过，因此不应谎称"已解除"
    expect(r.notifications.some((n) => n.kind === 'RECOVERED')).toBe(false);
  });

  it('降级后数据恢复 → 发出健康恢复通知并注明降级时长', async () => {
    makeTask('贵州茅台跌破1200元');

    chaos.setScenario('upstream_failure');
    const d = await runTask(deps, getTask());
    expect(d.stateAfter).toBe('DEGRADED');

    chaos.clear();
    clock.advance(30 * 60_000);
    repo.setTaskState(db, 'task1', 'DEGRADED', { nextRunAt: clock.now() });
    const r = await runTask(deps, getTask());

    expect(r.truth).toBe(false);
    const rec = r.notifications.find((n) => n.kind === 'HEALTH_RECOVERED');
    expect(rec).toBeTruthy();
    expect(rec!.text).toContain('30 分钟');
  });
});

describe('降级与失败计数', () => {
  it('连续失败达到阈值 → FAILED', async () => {
    makeTask('贵州茅台跌破1200元', { policy: { maxConsecutiveFailures: 2 } });
    chaos.setScenario('upstream_failure');

    await runTask(deps, getTask());
    expect(getTask().state).toBe('DEGRADED');

    clock.advance(60_000);
    repo.setTaskState(db, 'task1', 'DEGRADED', { nextRunAt: clock.now() });
    await runTask(deps, getTask());
    expect(getTask().state).toBe('FAILED');
  });

  it('数据过期 → DEGRADED 且原因码为 STALE', async () => {
    makeTask('贵州茅台跌破1200元');
    chaos.setScenario('stale_price');
    const r = await runTask(deps, getTask());
    expect(r.truth).toBe('unknown');
    expect(r.reasonCode).toBe('STALE');
    expect(getTask().state).toBe('DEGRADED');
  });

  it('降级时不产生 TRIGGERED 通知', async () => {
    makeTask('崇达技术出现涨停');
    chaos.setScenario('upstream_failure');
    const r = await runTask(deps, getTask());
    expect(r.notifications.filter((n) => n.kind === 'TRIGGERED')).toHaveLength(0);
  });
});

describe('TC-B2: 跨重启不重复通知', () => {
  it('去重键持久化，重建 deps 后仍生效', async () => {
    makeTask('崇达技术出现涨停', { policy: { cooldown: { kind: 'trading_day', value: 1 } } });
    await runTask(deps, getTask());

    // 模拟"重启"：新建 deps（同一个数据库，因为是 :memory: 共享连接）
    const deps2: EngineDeps = { ...deps, mesh: new SourceMesh({ primary: new ReplayAdapter() }) };
    clock.advance(60_000);
    repo.setTaskState(db, 'task1', 'PENDING', { cooldownUntil: null });

    const r = await runTask(deps2, getTask());
    expect(r.notifications.filter((n) => n.kind === 'TRIGGERED')).toHaveLength(0);
  });
});

describe('版本变化', () => {
  it('规则版本递增且历史保留', () => {
    const t = makeTask('贵州茅台跌破1200元');
    const v2: RuleDocument = { ...repo.getRuleDocument(db, t.activeRuleVersionId)!, id: 'task1_v2', version: 2 };
    repo.insertRuleDocument(db, v2);
    const all = repo.listRuleDocuments(db, 'task1');
    expect(all.map((d) => d.version)).toEqual([1, 2]);
    expect(repo.nextRuleVersion(db, 'task1')).toBe(3);
  });

  it('评估结果绑定当时的规则版本', async () => {
    const t = makeTask('贵州茅台跌破1200元');
    const r = await runTask(deps, t);
    const run = db.prepare('SELECT rule_version_id FROM runs WHERE id = ?').get(r.runId) as any;
    expect(run.rule_version_id).toBe('task1_v1');
  });

  it('改规则后重新评估使用新版本', async () => {
    const t = makeTask('贵州茅台跌破1200元');
    const v2 = { ...repo.getRuleDocument(db, t.activeRuleVersionId)!, id: 'task1_v2', version: 2 };
    repo.insertRuleDocument(db, v2);
    repo.upsertTask(db, { ...t, activeRuleVersionId: 'task1_v2' });
    clock.advance(120_000);
    const r = await runTask(deps, getTask());
    const run = db.prepare('SELECT rule_version_id FROM runs WHERE id = ?').get(r.runId) as any;
    expect(run.rule_version_id).toBe('task1_v2');
  });
});

describe('下次调度时间', () => {
  it('interval：直接加上间隔', () => {
    const t = makeTask('贵州茅台跌破1200元', {
      schedule: { kind: 'interval', everyMs: 60_000, tradingHoursOnly: false },
    });
    expect(computeNextRunAt(deps, t, T0)).toBe(T0 + 60_000);
  });

  it('TC-B6: dailyAt 在非交易日顺延', () => {
    // 2026-10-18 是周日
    const sunday = Date.parse('2026-10-18T08:00:00+08:00');
    const t = makeTask('贵州茅台跌破1200元', {
      schedule: { kind: 'dailyAt', times: ['09:35'], tradingDaysOnly: true },
    });
    const next = computeNextRunAt(deps, t, sunday);
    const sh = new Date(next + 8 * 3600 * 1000);
    expect(sh.getUTCDay()).not.toBe(0); // 不在周日
    expect(sh.getUTCDay()).not.toBe(6); // 不在周六
  });

  it('tradingHoursOnly 在收盘后顺延到次日开盘', () => {
    const afterClose = Date.parse('2026-10-15T16:00:00+08:00');
    const t = makeTask('贵州茅台跌破1200元', {
      schedule: { kind: 'interval', everyMs: 60_000, tradingHoursOnly: true },
    });
    const next = computeNextRunAt(deps, t, afterClose);
    const sh = new Date(next + 8 * 3600 * 1000);
    expect(sh.getUTCHours()).toBe(9);
    expect(sh.getUTCMinutes()).toBe(30);
  });

  it('午休时段顺延到 13:00', () => {
    const noon = Date.parse('2026-10-15T12:00:00+08:00');
    const t = makeTask('贵州茅台跌破1200元', {
      schedule: { kind: 'interval', everyMs: 60_000, tradingHoursOnly: true },
    });
    const next = computeNextRunAt(deps, t, noon);
    const sh = new Date(next + 8 * 3600 * 1000);
    expect(sh.getUTCHours()).toBe(13);
  });
});

describe('事件日志（状态变迁可追溯）', () => {
  it('状态变化被记录到 events', async () => {
    makeTask('崇达技术出现涨停');
    await runTask(deps, getTask());
    const evts = repo.listEvents(db, 'task1');
    expect(evts.length).toBeGreaterThan(0);
    const sc = evts.find((e) => e.kind === 'STATE_CHANGE');
    expect(sc).toBeTruthy();
    expect(sc.from_state).toBe('PENDING');
    expect(sc.to_state).toBe('COOLDOWN');
  });
});

describe('证据落库', () => {
  it('每次评估后的证据可查询且含五要素', async () => {
    makeTask('贵州茅台跌破1200元');
    const r = await runTask(deps, getTask());
    const evs = repo.listEvidenceByRun(db, r.runId!);
    expect(evs.length).toBeGreaterThan(0);
    const p = evs[0]!.payload;
    expect(p.observations[0].source.endpoint).toBeTruthy();
    expect(p.observations[0].dataTimestampMs).toBeTruthy();
    expect(p.observations[0].unit).toBe('CNY');
    expect(p.observations[0].statisticBasis).toBeTruthy();
    expect(p.observations[0].source.rawResponseRef).toBeTruthy();
  });

  it('原始响应已落库，可回链', async () => {
    makeTask('贵州茅台跌破1200元');
    const r = await runTask(deps, getTask());
    const evs = repo.listEvidenceByRun(db, r.runId!);
    const ref = evs[0]!.payload.observations[0].source.rawResponseRef;
    const raw = repo.getRawResponse(db, ref);
    expect(raw).toBeTruthy();
    expect(raw.endpoint).toBe('/api/a-share/prices/snapshot');
    expect(raw.body).toBeTruthy();
  });
});

/**
 * 站外推送的投递留痕。
 *
 * 「触发了但用户没收到」是最容易被静默吞掉的一环：通知写进了库，界面也显示了，
 * 但没送到人那儿，而系统看起来一切正常。所以每一次投递都必须有明确去向。
 */
describe('站外推送：每次通知都要有明确去向', () => {
  it('未注入渠道 → 通知照常生成，投递如实记为 SKIPPED 并写明原因', async () => {
    makeTask('崇达技术出现涨停');
    const r = await runTask(deps, getTask());

    expect(r.notifications.length).toBeGreaterThan(0);

    const dlv = repo.listDeliveries(db, 'task1');
    expect(dlv.length).toBe(r.notifications.length);
    expect(dlv[0]!.status).toBe('SKIPPED');
    expect(dlv[0]!.last_error).toContain('未配置');
  });

  it('注入渠道 → 记为 SENT，且投递内容与通知一一对应', async () => {
    const sent: any[] = [];
    deps.delivery = {
      name: 'webhook',
      deliver: async (n) => {
        sent.push(n);
        return { status: 'SENT', attempts: 1, httpStatus: 200 };
      },
    };

    makeTask('崇达技术出现涨停');
    const r = await runTask(deps, getTask());

    expect(sent.length).toBe(r.notifications.length);
    expect(sent[0]!.text).toBe(r.notifications[0]!.text);
    // 任务名随投递一起送出，收端不必再回查
    expect(sent[0]!.taskName).toBeTruthy();

    const dlv = repo.listDeliveries(db, 'task1');
    expect(dlv.every((d) => d.status === 'SENT')).toBe(true);
    expect(dlv[0]!.attempts).toBe(1);
  });

  it('渠道抛错不能带崩 tick，但失败必须留痕', async () => {
    deps.delivery = {
      name: 'webhook',
      deliver: async () => {
        throw new Error('boom: 渠道内部错误');
      },
    };

    makeTask('崇达技术出现涨停');
    const r = await runTask(deps, getTask());

    // tick 正常完成，通知也在
    expect(r.notifications.length).toBeGreaterThan(0);

    const dlv = repo.listDeliveries(db, 'task1');
    expect(dlv[0]!.status).toBe('FAILED');
    expect(dlv[0]!.last_error).toContain('boom');
  });

  it('重新投递同一条通知时更新原记录，不追加重复行', async () => {
    const now = clock.now();
    repo.recordDelivery(
      db,
      { notificationId: 'n1', taskId: 'task1', channel: 'webhook', status: 'FAILED', attempts: 3, lastError: 'HTTP 500' },
      now,
    );
    repo.recordDelivery(
      db,
      { notificationId: 'n1', taskId: 'task1', channel: 'webhook', status: 'SENT', attempts: 1, httpStatus: 200 },
      now + 1000,
    );

    const rows = repo.listDeliveries(db, 'task1');
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('SENT');
    expect(rows[0]!.last_error).toBeNull();
  });
});
