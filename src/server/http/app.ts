/**
 * HTTP API。
 *
 * 刻意保持薄：所有业务逻辑都在 domain / scheduler 里，路由只做
 * 「解析入参 → 调用 → 序列化」，这样 API 层不需要测试就能信任。
 */

import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { ZodError } from 'zod';
import * as repo from '../store/repo.js';
import { newId } from '../store/db.js';
import { parseNaturalLanguage, type CatalogEntry } from '../nl/parser.js';
import { RuleDocumentSchema } from '../../shared/dsl/schema.js';
import { validateRule } from '../domain/validate.js';
import { runTask, type EngineDeps } from '../scheduler/engine.js';
import { listComplianceRejects, recordComplianceReject } from '../store/repo.js';
import type { MonitorTask, RuleDocument, Schedule, TriggerPolicy } from '../../shared/dsl/types.js';
import type { ChaosScenario } from '../sources/chaos.adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppContext {
  db: DatabaseSync;
  deps: EngineDeps;
  catalog: CatalogEntry[];
  /**
   * 数据来源的**事实描述**，由 index.ts 根据**实际装配的适配器**填写。
   *
   * 刻意不从环境变量推导：环境变量描述的是"用户想要什么"，而这里要报告的是
   * "实际发生了什么"。二者一旦分离，界面就会在用户设了 live 却拿不到实时数据时
   * 把回放数据标成实时数据 —— 那正是本项目最不能犯的错。
   */
  dataSource: { kind: 'replay' | 'live'; label: string; note: string };
  chaos: { activeScenario: ChaosScenario | null; setScenario: (s: ChaosScenario | null, o?: any) => void; clear: () => void };
  loadCalendar: () => Promise<number>;
  startScheduler: () => void;
  stopScheduler: () => void;
  schedulerRunning: () => boolean;
}

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const { db } = ctx;
  const names = new Map(ctx.catalog.map((c) => [c.thscode, c.name]));

  // ────────────── 健康与元信息 ──────────────

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'sentinel',
      // 报告实际在用的适配器，而不是用户设的环境变量
      mode: ctx.dataSource.kind,
      schedulerRunning: ctx.schedulerRunning(),
      chaos: ctx.chaos.activeScenario,
      calendarDays: repo.calendarCount(db),
      now: new Date().toISOString(),
    });
  });

  app.get('/api/catalog', (_req, res) => {
    res.json({ ok: true, instruments: ctx.catalog });
  });

  app.get('/api/meta', (_req, res) => {
    res.json({
      ok: true,
      // 如实披露数据来源，不假装是扶摇返回的。来源由实际适配器决定。
      dataSource: ctx.dataSource.label,
      dataSourceNote: ctx.dataSource.note,
      chaos: ctx.chaos.activeScenario,
      compliance: '本产品不预测涨跌、不承诺收益、不构成买卖建议；事实、推断与不确定信息严格区分。',
    });
  });

  // ────────────── 自然语言 → 规则 ──────────────

  app.post('/api/rules/parse', (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ ok: false, message: '缺少 text 字段' });

    const outcome = parseNaturalLanguage(text, ctx.catalog);

    if (!outcome.ok) {
      // 合规拒绝留痕，可追溯
      if (outcome.kind === 'compliance') {
        recordComplianceReject(db, {
          rawText: text,
          label: outcome.complianceLabel ?? '未分类',
          now: ctx.deps.now(),
        });
      }
      return res.json({
        ok: false,
        kind: outcome.kind,
        message: outcome.message,
        complianceLabel: outcome.complianceLabel ?? null,
      });
    }

    // 解析成功也要过语义校验，把问题提前暴露给用户
    const report = validateRule(outcome.root, outcome.scope, ctx.catalog);

    return res.json({
      ok: true,
      scope: outcome.scope,
      root: outcome.root,
      meta: outcome.meta,
      warnings: [...outcome.warnings, ...report.warnings],
      errors: report.errors,
      summary: summarize(outcome.root, names),
    });
  });

  // ────────────── 任务 ──────────────

  app.get('/api/tasks', (_req, res) => {
    const tasks = repo.listTasks(db, true).map((t) => decorate(t));
    res.json({ ok: true, tasks });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const t = repo.getTask(db, req.params.id);
    if (!t) return res.status(404).json({ ok: false, message: '任务不存在' });
    const rule = repo.getRuleDocument(db, t.activeRuleVersionId);
    res.json({
      ok: true,
      task: decorate(t),
      rule,
      ruleHistory: repo.listRuleDocuments(db, t.id).map((r) => ({
        id: r.id,
        version: r.version,
        createdAt: r.createdAt,
        author: r.author,
        rawText: r.source.rawText ?? null,
      })),
      runs: repo.recentRuns(db, t.id, 20),
      notifications: repo.listNotifications(db, t.id, 50),
      suppressed: repo.listSuppressed(db, t.id, 50),
      events: repo.listEvents(db, t.id, 50),
    });
  });

  app.post('/api/tasks', (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    const name = String(req.body?.name ?? text ?? '未命名监控').slice(0, 80);
    if (!text) return res.status(400).json({ ok: false, message: '缺少 text 字段' });

    const parsed = parseNaturalLanguage(text, ctx.catalog);
    if (!parsed.ok) {
      if (parsed.kind === 'compliance') {
        recordComplianceReject(db, {
          rawText: text,
          label: parsed.complianceLabel ?? '未分类',
          now: ctx.deps.now(),
        });
      }
      return res.status(400).json({ ok: false, kind: parsed.kind, message: parsed.message });
    }

    const report = validateRule(parsed.root, parsed.scope, ctx.catalog);
    if (report.errors.length > 0) {
      return res.status(400).json({ ok: false, kind: 'invalid', message: report.errors.join('；') });
    }

    const id = newId('task');
    const now = ctx.deps.now();
    const rule: RuleDocument = {
      id: `${id}_v1`,
      taskId: id,
      schemaVersion: '1.0.0',
      version: 1,
      createdAt: now,
      author: 'nl_parser',
      source: { kind: 'nl', rawText: text, parseMeta: parsed.meta },
      scope: parsed.scope,
      root: parsed.root,
    };
    repo.insertRuleDocument(db, rule);

    const schedule: Schedule = req.body?.schedule ?? {
      kind: 'interval',
      everyMs: 30_000,
      tradingHoursOnly: false,
    };
    const policy: TriggerPolicy = {
      triggerMode: req.body?.policy?.triggerMode ?? 'level',
      cooldown: req.body?.policy?.cooldown ?? { kind: 'hours', value: 4 },
      notifyOnRecovery: req.body?.policy?.notifyOnRecovery ?? true,
      maxConsecutiveFailures: req.body?.policy?.maxConsecutiveFailures ?? 3,
    };

    const task: MonitorTask = {
      id,
      name,
      activeRuleVersionId: rule.id,
      schedule,
      policy,
      state: 'PENDING',
      health: { consecutiveFailures: 0, lastEvaluatedAt: null, lastReasonCode: null, degradedSince: null },
      cooldownUntil: null,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    };
    repo.upsertTask(db, task);
    repo.logEvent(db, { taskId: id, kind: 'CREATED', payload: { rawText: text }, now });

    res.status(201).json({ ok: true, task: decorate(task), rule, warnings: report.warnings });
  });

  /** 修改规则 → 生成新版本（历史保留，不可回改） */
  app.put('/api/tasks/:id/rule', (req, res) => {
    const t = repo.getTask(db, req.params.id);
    if (!t) return res.status(404).json({ ok: false, message: '任务不存在' });

    let root = req.body?.root;
    let rawText = req.body?.text ? String(req.body.text) : undefined;
    let scope = req.body?.scope;
    let parseMeta;

    if (!root && rawText) {
      const parsed = parseNaturalLanguage(rawText, ctx.catalog);
      if (!parsed.ok) {
        if (parsed.kind === 'compliance') {
          recordComplianceReject(db, {
            rawText,
            label: parsed.complianceLabel ?? '未分类',
            now: ctx.deps.now(),
          });
        }
        return res.status(400).json({ ok: false, kind: parsed.kind, message: parsed.message });
      }
      root = parsed.root;
      scope = parsed.scope;
      parseMeta = parsed.meta;
    }
    if (!root || !scope) {
      return res.status(400).json({ ok: false, message: '需要提供 root+scope 或 text' });
    }

    const report = validateRule(root, scope, ctx.catalog);
    if (report.errors.length > 0) {
      return res.status(400).json({ ok: false, kind: 'invalid', message: report.errors.join('；') });
    }

    const prev = repo.getRuleDocument(db, t.activeRuleVersionId);
    const version = repo.nextRuleVersion(db, t.id);
    const now = ctx.deps.now();
    const doc: RuleDocument = {
      id: `${t.id}_v${version}`,
      taskId: t.id,
      schemaVersion: '1.0.0',
      version,
      createdAt: now,
      author: rawText ? 'nl_parser' : 'user',
      source: { kind: rawText ? 'nl' : 'manual', ...(rawText ? { rawText, parseMeta } : {}) },
      scope,
      root,
    };
    repo.insertRuleDocument(db, doc, diffRule(prev?.root, root));
    repo.upsertTask(db, { ...t, activeRuleVersionId: doc.id, updatedAt: now });
    repo.logEvent(db, {
      taskId: t.id,
      kind: 'RULE_VERSION_BUMP',
      payload: { from: prev?.version ?? 0, to: version, rawText: rawText ?? null },
      now,
    });

    res.json({ ok: true, rule: doc, warnings: report.warnings });
  });

  /** 强制评估一次（演示与调试用） */
  app.post('/api/tasks/:id/run', async (req, res, next) => {
    try {
      const t = repo.getTask(db, req.params.id);
      if (!t) return res.status(404).json({ ok: false, message: '任务不存在' });
      const result = await runTask(ctx.deps, t, { force: true });
      const after = repo.getTask(db, t.id);
      res.json({ ok: true, result: serializeRun(result), task: after ? decorate(after) : null });
    } catch (e) {
      next(e);
    }
  });

  /** 暂停 / 恢复 / 归档 */
  app.post('/api/tasks/:id/state', (req, res) => {
    const t = repo.getTask(db, req.params.id);
    if (!t) return res.status(404).json({ ok: false, message: '任务不存在' });
    const action = String(req.body?.action ?? '');
    const now = ctx.deps.now();

    if (action === 'pause') {
      repo.setTaskState(db, t.id, 'PAUSED');
      repo.logEvent(db, { taskId: t.id, kind: 'PAUSED', from: t.state, to: 'PAUSED', now });
    } else if (action === 'resume') {
      repo.setTaskState(db, t.id, 'PENDING', { nextRunAt: now });
      repo.logEvent(db, { taskId: t.id, kind: 'RESUMED', from: t.state, to: 'PENDING', now });
    } else if (action === 'archive') {
      repo.setTaskState(db, t.id, 'ARCHIVED');
      repo.logEvent(db, { taskId: t.id, kind: 'ARCHIVED', from: t.state, to: 'ARCHIVED', now });
    } else {
      return res.status(400).json({ ok: false, message: 'action 必须是 pause/resume/archive' });
    }
    res.json({ ok: true, task: decorate(repo.getTask(db, t.id)!) });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const t = repo.getTask(db, req.params.id);
    if (!t) return res.status(404).json({ ok: false, message: '任务不存在' });
    repo.setTaskState(db, t.id, 'ARCHIVED');
    res.json({ ok: true });
  });

  // ────────────── 证据 ──────────────

  app.get('/api/evidence/by-run/:runId', (req, res) => {
    res.json({ ok: true, items: repo.listEvidenceByRun(db, req.params.runId) });
  });

  app.get('/api/evidence/:id', (req, res) => {
    const e = repo.getEvidence(db, req.params.id);
    if (!e) return res.status(404).json({ ok: false, message: '证据不存在' });
    const obs = e.payload?.observations ?? [];
    const raw = obs[0]?.source?.rawResponseRef ? repo.getRawResponse(db, obs[0].source.rawResponseRef) : null;
    res.json({ ok: true, evidence: e.payload, rawResponse: raw });
  });

  app.get('/api/raw/:id', (req, res) => {
    const r = repo.getRawResponse(db, req.params.id);
    if (!r) return res.status(404).json({ ok: false, message: '原始响应不存在' });
    res.json({ ok: true, raw: r });
  });

  // ────────────── 风险雷达 ──────────────

  app.get('/api/radar', (_req, res) => {
    const tasks = repo.listTasks(db);
    const days = 7;
    const since = ctx.deps.now() - days * 24 * 3600_000;

    const rows = tasks.map((t) => {
      const rule = repo.getRuleDocument(db, t.activeRuleVersionId);
      const notifs = repo.listNotifications(db, t.id, 100).filter((n) => n.created_at >= since);
      const kinds = new Set(collectLeafKinds(rule?.root));
      return {
        taskId: t.id,
        name: t.name,
        state: t.state,
        reasonCode: t.health.lastReasonCode,
        lastEvaluatedAt: t.health.lastEvaluatedAt,
        degradedSince: t.health.degradedSince,
        cooldownUntil: t.cooldownUntil,
        kinds: [...kinds],
        triggered7d: notifs.filter((n) => n.kind === 'TRIGGERED').length,
        recovered7d: notifs.filter((n) => n.kind === 'RECOVERED').length,
        suppressed: repo.countSuppressed(db, t.id, since),
        latestNarrative: notifs[0]?.text ?? null,
      };
    });

    // 聚合矩阵：维度 × 状态
    const dims: ('price' | 'event' | 'calendar' | 'heat')[] = ['price', 'event', 'calendar', 'heat'];
    const states = ['PENDING', 'COOLDOWN', 'DEGRADED', 'FAILED', 'PAUSED'];
    const matrix = dims.map((dim) => ({
      dim,
      cells: states.map((st) => ({
        state: st,
        count: rows.filter((r) => r.kinds.includes(dim) && r.state === st).length,
      })),
    }));

    res.json({
      ok: true,
      rows,
      matrix,
      summary: {
        total: rows.length,
        degraded: rows.filter((r) => r.state === 'DEGRADED').length,
        failed: rows.filter((r) => r.state === 'FAILED').length,
        triggered7d: rows.reduce((s, r) => s + r.triggered7d, 0),
        suppressed7d: rows.reduce((s, r) => s + r.suppressed, 0),
      },
    });
  });

  // ────────────── 故障注入 ──────────────

  app.get('/api/chaos', (_req, res) => {
    res.json({
      ok: true,
      active: ctx.chaos.activeScenario,
      scenarios: [
        { id: 'stale_price', label: '数据过期', desc: '把数据时点推到当前生效阈值之外' },
        { id: 'conflict_price', label: '源冲突', desc: '备源给出 0.87% 的偏差' },
        { id: 'upstream_failure', label: '接口失败', desc: '上游返回 code 5003' },
        { id: 'rate_limited', label: '接口限流', desc: '返回 code 4001' },
        { id: 'not_ready', label: '数据未就绪', desc: '返回 code 3002' },
        { id: 'capability_denied', label: '能力未开放', desc: '返回 code 2003' },
        { id: 'partial_null', label: '字段缺失', desc: '金额字段置空（不补零）' },
        { id: 'malformed', label: '非标准响应', desc: '返回网关 HTML 错误页' },
      ],
    });
  });

  /**
   * 故障注入开关。
   *
   * 关于作用域：从演示面板点击时**默认作用于所有端点**——
   * 用户点「数据未就绪」时正在看的可能是价格任务，若按场景内置的窄作用域
   * 只在异动端点上生效，点了会毫无反应，演示就砸了。
   * 需要精准打击时显式传 endpoints（冒烟测试与单元测试就是这么用的）。
   */
  app.post('/api/chaos', (req, res) => {
    const scenario = req.body?.scenario ?? null;
    if (scenario === null || scenario === 'none') {
      ctx.chaos.clear();
      repo.setAppState(db, 'chaos', null);
    } else {
      ctx.chaos.setScenario(scenario, {
        endpoints: Array.isArray(req.body?.endpoints) ? req.body.endpoints : [],
        staleMs: req.body?.staleMs,
      });
      repo.setAppState(db, 'chaos', { scenario, at: ctx.deps.now() });
    }
    res.json({ ok: true, active: ctx.chaos.activeScenario });
  });

  // ────────────── 合规留痕 ──────────────

  app.get('/api/compliance/rejects', (_req, res) => {
    res.json({ ok: true, rejects: listComplianceRejects(db, 50) });
  });

  // ────────────── 日历 ──────────────

  app.post('/api/calendar/reload', async (_req, res, next) => {
    try {
      const n = await ctx.loadCalendar();
      res.json({ ok: true, days: n });
    } catch (e) {
      next(e);
    }
  });

  // ────────────── 静态资源 ──────────────

  const webDist = join(__dirname, '..', '..', '..', 'dist', 'web');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
  } else {
    app.get('/', (_req, res) => {
      res.type('html').send(
        '<h1>哨兵 Sentinel</h1><p>前端未构建。开发模式请访问 5173，或运行 <code>npm run build</code>。</p>',
      );
    });
  }

  // ────────────── 错误处理 ──────────────

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ ok: false, message: '规则结构不合法', issues: err.issues });
    }
    console.error('[api] 未捕获错误:', err);
    res.status(500).json({ ok: false, message: err?.message ?? '服务内部错误' });
  });

  return app;

  // ────────────── 辅助 ──────────────

  function decorate(t: MonitorTask) {
    const rule = repo.getRuleDocument(db, t.activeRuleVersionId);
    return {
      ...t,
      ruleVersion: rule?.version ?? null,
      ruleText: rule?.source.rawText ?? null,
      summary: rule ? summarize(rule.root, names) : null,
      nextRunAtHuman: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null,
      suppressedCount: repo.countSuppressed(db, t.id, ctx.deps.now() - 24 * 3600_000),
    };
  }

  function serializeRun(r: Awaited<ReturnType<typeof runTask>>) {
    return {
      taskId: r.taskId,
      runId: r.runId,
      skipped: r.skipped,
      skipReason: r.skipReason ?? null,
      truth: r.truth ?? null,
      reasonCode: r.reasonCode ?? null,
      stateBefore: r.stateBefore ?? null,
      stateAfter: r.stateAfter ?? null,
      notifications: r.notifications,
      suppressedCount: r.suppressedCount,
      narrative: r.evaluation?.narrative ?? null,
      leaves:
        r.evaluation?.leaves.map((l) => ({
          leafId: l.leafId,
          kind: l.kind,
          truth: l.truth,
          reasonCode: l.reasonCode,
          evidenceId: l.evidence.evidenceId,
          narrative: l.evidence.narrative,
          observations: l.evidence.observations,
          freshness: l.evidence.freshness,
          comparison: l.evidence.comparison ?? null,
          conflicts: l.evidence.conflicts ?? [],
        })) ?? [],
    };
  }
}

// ────────────────────────── 摘要与差异 ──────────────────────────

/** 把条件树压成一行人话，用于任务卡片 */
export function summarize(root: any, names: Map<string, string>): string {
  const parts: string[] = [];

  const walk = (c: any, depth: number): string => {
    if (c.type === 'and') return c.children.map((x: any) => walk(x, depth + 1)).join(' 并且 ');
    if (c.type === 'or') return c.children.map((x: any) => walk(x, depth + 1)).join(' 或者 ');
    if (c.type === 'not') return `非(${walk(c.child, depth + 1)})`;

    const name =
      (c.subject?.thscode ? names.get(c.subject.thscode) : null) ??
      c.subject?.name ??
      c.subject?.thscode ??
      '该标的';

    if (c.type === 'price') {
      const label: Record<string, string> = {
        last_price: '最新价',
        close_price: '收盘价',
        price_change_ratio_pct: '涨跌幅',
        return_pct_window: `近${c.window?.days ?? ''}日累计涨跌幅`,
        drawdown_from_high_pct: `近${c.window?.days ?? ''}日回撤`,
        volume_ratio: '量比',
        turnover: '成交额',
        volume: '成交量',
      };
      const unit = c.value?.unit === 'PCT' ? '%' : c.value?.unit === 'CNY' ? '元' : '';
      const op: Record<string, string> = { '<': '低于', '<=': '不高于', '>': '高于', '>=': '不低于', '==': '等于' };
      return `${name} ${label[c.metric] ?? c.metric} ${op[c.operator] ?? c.operator} ${c.value?.value}${unit}`;
    }
    if (c.type === 'event') {
      const label: Record<string, string> = {
        limit_up_pool: '涨停',
        limit_down_pool: '跌停',
        limit_break_pool: '炸板',
        limit_up_ladder: '连板',
        dragon_tiger_list: '登上龙虎榜',
        anomaly_analysis_list: '出现异动',
        abnormal_monitor_list: '被列入监控',
      };
      const cnt = c.filter?.minContinueDayCnt ? `连续${c.filter.minContinueDayCnt}天` : '';
      return `${name} ${cnt}${label[c.source] ?? c.source}`;
    }
    if (c.type === 'heat') {
      return `${name} 热度排名 ${c.operator} ${c.value?.value}`;
    }
    if (c.type === 'calendar') {
      const label: Record<string, string> = {
        is_trading_day: '是交易日',
        is_not_trading_day: '非交易日',
        nth_trading_day_of_month: `本月第 ${c.param?.nth ?? 1} 个交易日`,
      };
      return label[c.predicate] ?? c.predicate;
    }
    return c.type;
  };

  parts.push(walk(root, 0));
  return parts.join('');
}

/** 相邻规则版本的差异，用于「规则版本时间线」 */
export function diffRule(prev: any, next: any): any {
  if (!prev) return { added: [next?.id], removed: [], changed: [] };
  const flat = (c: any, out: any[] = []): any[] => {
    if (!c) return out;
    if (c.type === 'and' || c.type === 'or') c.children.forEach((x: any) => flat(x, out));
    else if (c.type === 'not') flat(c.child, out);
    else out.push({ id: c.id, type: c.type, metric: c.metric, operator: c.operator, value: c.value?.value });
    return out;
  };
  const a = flat(prev);
  const b = flat(next);
  const byType = (arr: any[]) => arr.map((x) => `${x.type}:${x.metric ?? ''}:${x.operator ?? ''}:${x.value ?? ''}`);
  const setA = new Set(byType(a));
  const setB = new Set(byType(b));
  return {
    added: byType(b).filter((x) => !setA.has(x)),
    removed: byType(a).filter((x) => !setB.has(x)),
    changed: byType(b).filter((x) => setA.has(x) && !setB.has(x)),
  };
}

function collectLeafKinds(root: any): string[] {
  if (!root) return [];
  if (root.type === 'and' || root.type === 'or') return root.children.flatMap(collectLeafKinds);
  if (root.type === 'not') return collectLeafKinds(root.child);
  return [root.type];
}
