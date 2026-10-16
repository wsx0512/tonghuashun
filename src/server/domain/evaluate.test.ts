/**
 * 评估器测试 —— 对应测试计划 A/C 组的核心部分。
 * 重点验证：三值逻辑不塌缩、证据链完整、降级原因正确归因。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplayAdapter } from '../sources/replay.adapter.js';
import type { SourceAdapter } from '../sources/types.js';
import { ChaosAdapter } from '../sources/chaos.adapter.js';
import { canonicalParams, resolveDataNeeds } from './dataNeeds.js';
import { evaluateRule, type DataBundle } from './evaluate.js';
import { resetNodeIds, parseNaturalLanguage, type CatalogEntry } from '../nl/parser.js';
import { ManualClock, setClock, resetClock } from '../clock.js';
import type { Condition } from '../../shared/dsl/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog: CatalogEntry[] = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'fixtures', 'catalog.json'), 'utf8'),
).instruments;
const names = new Map(catalog.map((c) => [c.thscode, c.name]));

const FIXED_NOW = Date.parse('2026-10-15T15:05:00+08:00');

beforeEach(() => {
  setClock(new ManualClock(FIXED_NOW));
  resetNodeIds();
});
afterEach(() => {
  resetClock();
});

/** 解析自然语言 → 条件树（测试里最省事的建规则方式） */
function cond(text: string): Condition {
  const r = parseNaturalLanguage(text, catalog);
  if (!r.ok) throw new Error(`解析失败：${r.message}`);
  return r.root;
}

/** 按条件树的数据需求取数，组装成 bundle */
async function bundleFor(root: Condition, adapter: SourceAdapter): Promise<DataBundle> {
  const bundle: DataBundle = new Map();
  for (const need of resolveDataNeeds(root)) {
    const key = `${need.endpoint}?${canonicalParams(need.params)}`;
    if (bundle.has(key)) continue;
    const result = await adapter.fetch({ endpoint: need.endpoint, params: need.params });
    bundle.set(key, { endpoint: need.endpoint, params: need.params, result });
  }
  return bundle;
}

async function evaluate(text: string, adapter: SourceAdapter = new ReplayAdapter()) {
  const root = cond(text);
  const bundle = await bundleFor(root, adapter);
  return {
    root,
    result: evaluateRule({
      root,
      taskId: 't1',
      ruleVersionId: 'v1',
      runId: 'r1',
      bundle,
      conflicts: [],
      now: FIXED_NOW,
      subjectName: (code) => names.get(code) ?? code,
    }),
  };
}

describe('主链路：条件命中与未命中', () => {
  it('茅台最新价 1312.97 高于阈值 1200 → true', async () => {
    const { result } = await evaluate('贵州茅台股价高于1200元');
    expect(result.truth).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.leaves[0]!.truth).toBe(true);
  });

  it('茅台最新价 1312.97 低于阈值 1400 → true（方向正确）', async () => {
    const { result } = await evaluate('贵州茅台跌破1400元');
    expect(result.truth).toBe(true);
  });

  it('茅台最新价 1312.97 低于阈值 1200 → false', async () => {
    const { result } = await evaluate('贵州茅台跌破1200元');
    expect(result.truth).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it('茅台涨幅 2.1% 未达 5% → false', async () => {
    const { result } = await evaluate('贵州茅台涨幅超过5%');
    expect(result.truth).toBe(false);
  });

  it('崇达技术今日在涨停池 → 事件条件为 true', async () => {
    const { result } = await evaluate('崇达技术出现涨停');
    expect(result.truth).toBe(true);
    expect(result.leaves[0]!.kind).toBe('event');
  });

  it('茅台今日未涨停 → 事件条件为 false（"不在池中"是有效事实，不是未知）', async () => {
    const { result } = await evaluate('贵州茅台出现涨停');
    expect(result.truth).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it('茅台进入热榜前10（实际未上榜）→ false', async () => {
    const { result } = await evaluate('贵州茅台进入热榜前10');
    expect(result.truth).toBe(false);
  });

  it('华北制药在人气榜第 2 名 → 进入前 5 为 true', async () => {
    const { result } = await evaluate('华北制药进入热榜前5');
    expect(result.truth).toBe(true);
  });

  it('今天是交易日 → 日历条件为 true', async () => {
    const { result } = await evaluate('贵州茅台每个交易日');
    expect(result.truth).toBe(true);
  });
});

describe('三值逻辑：unknown 绝不塌缩为 false', () => {
  it('数据获取失败 → unknown，且任务进入降级', async () => {
    const chaos = new ChaosAdapter();
    chaos.setScenario('upstream_failure');
    const { result } = await evaluate('贵州茅台跌破1200元', chaos);

    expect(result.truth).toBe('unknown');
    expect(result.truth).not.toBe(false); // ★ 核心断言
    expect(result.degraded).toBe(true);
    expect(result.reasonCode).toBe('FAILURE');
  });

  it('数据过期 → unknown 且归因 STALE', async () => {
    const chaos = new ChaosAdapter();
    chaos.setScenario('stale_price');
    const { result } = await evaluate('贵州茅台跌破1200元', chaos);

    expect(result.truth).toBe('unknown');
    expect(result.reasonCode).toBe('STALE');
    expect(result.leaves[0]!.evidence.freshness.fresh).toBe(false);
  });

  it('能力未开放 → CAPABILITY_DENIED', async () => {
    const chaos = new ChaosAdapter();
    chaos.setScenario('capability_denied', { endpoints: ['/api/a-share/special-data/limit-up-pool'] });
    const { result } = await evaluate('崇达技术出现涨停', chaos);
    expect(result.truth).toBe('unknown');
    expect(result.reasonCode).toBe('CAPABILITY_DENIED');
  });

  it('TC-C10: AND(true, unknown) → unknown', async () => {
    const chaos = new ChaosAdapter();
    // 只让价格端点失败，事件端点正常
    chaos.setScenario('upstream_failure', { endpoints: ['/api/a-share/prices/snapshot'] });

    const { root, result } = await evaluate('崇达技术出现涨停 并且 崇达技术股价高于10元', chaos);
    expect(root.type).toBe('and');
    expect(result.truth).toBe('unknown');
    expect(result.degraded).toBe(true);
  });

  it('TC-C10: OR(true, unknown) → true（一支为真即可定论）', async () => {
    const chaos = new ChaosAdapter();
    chaos.setScenario('upstream_failure', { endpoints: ['/api/a-share/prices/snapshot'] });

    const { root, result } = await evaluate('崇达技术出现涨停 或者 崇达技术股价高于10元', chaos);
    expect(root.type).toBe('or');
    expect(result.truth).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it('TC-C11: 组合中只有一个叶子降级，其余为真 → 整体仍为 unknown', async () => {
    const chaos = new ChaosAdapter();
    chaos.setScenario('upstream_failure', { endpoints: ['/api/a-share/prices/snapshot'] });

    const { result } = await evaluate('崇达技术出现涨停 并且 崇达技术股价高于10元', chaos);
    const trues = result.leaves.filter((l) => l.truth === true);
    const unknowns = result.leaves.filter((l) => l.truth === 'unknown');
    expect(trues.length).toBe(1); // 事件命中
    expect(unknowns.length).toBe(1); // 价格无法判定
    expect(result.truth).toBe('unknown');
  });
});

describe('TC-C7b: 源冲突时不得给出肯定结论', () => {
  it('主备源对该字段不一致 → 判为 unknown 而非 false', async () => {
    const root = cond('贵州茅台跌破1200元');
    const adapter = new ReplayAdapter();
    const bundle = await bundleFor(root, adapter);

    // 模拟 SourceMesh 检出的冲突
    const conflicts = [
      {
        thscode: '600519.SH',
        field: 'last_price',
        valueA: 1312.97,
        sourceA: 'fuyao',
        valueB: 1324.39,
        sourceB: 'backup',
        deltaPct: 0.0086,
      },
    ];

    const r = evaluateRule({
      root,
      taskId: 't1',
      ruleVersionId: 'v1',
      runId: 'r1',
      bundle,
      conflicts,
      now: FIXED_NOW,
      subjectName: (code) => names.get(code) ?? code,
    });

    // 核心：不能因为"主源的值没到阈值"就断言条件未满足
    expect(r.truth).toBe('unknown');
    expect(r.truth).not.toBe(false);
    expect(r.reasonCode).toBe('CONFLICT');
    expect(r.degraded).toBe(true);

    // 两个取值都要保留，让用户自己判断
    const ev = r.leaves[0]!.evidence;
    expect(ev.conflicts).toHaveLength(1);
    expect(ev.conflicts![0]!.valueA).toBe(1312.97);
    expect(ev.conflicts![0]!.valueB).toBe(1324.39);
    expect(ev.narrative).toContain('冲突');
  });

  it('无冲突时正常判定，且不该出现 conflicts 字段', async () => {
    const { result } = await evaluate('贵州茅台跌破1200元');
    expect(result.leaves[0]!.evidence.conflicts).toBeUndefined();
    expect(result.truth).toBe(false);
  });
});

describe('可追溯性（TC-E1 ~ TC-E3）', () => {
  it('TC-E3: 每条 evidence 的五要素齐全', async () => {
    const { result } = await evaluate('贵州茅台跌破1200元');
    const ev = result.leaves[0]!.evidence;

    expect(ev.observations.length).toBeGreaterThan(0);
    const obs = ev.observations[0]!;

    // 来源
    expect(obs.source.endpoint).toBe('/api/a-share/prices/snapshot');
    expect(obs.source.provider).toBeTruthy();
    // 时点
    expect(obs.dataTimestampMs).not.toBeNull();
    // 单位
    expect(obs.unit).toBe('CNY');
    // 口径
    expect(obs.statisticBasis).toBeTruthy();
    // 原始响应引用 + request_id
    expect(obs.source.rawResponseRef).toBeTruthy();
    expect(obs.source.requestId).toBeTruthy();
    expect(obs.source.requestParams.thscodes).toBe('600519.SH');
  });

  it('TC-E2: evidence 绑定到确切的规则版本', async () => {
    const { result } = await evaluate('贵州茅台跌破1200元');
    expect(result.leaves[0]!.evidence.ruleVersionId).toBe('v1');
    expect(result.leaves[0]!.evidence.runId).toBe('r1');
  });

  it('观测值就是原始字段值，无中间计算', async () => {
    const { result } = await evaluate('贵州茅台跌破1200元');
    const obs = result.leaves[0]!.evidence.observations[0]!;
    expect(obs.field).toBe('last_price');
    expect(obs.value).toBeCloseTo(1312.97, 2);
  });

  it('比较过程被记录，可核对', async () => {
    const { result } = await evaluate('贵州茅台跌破1200元');
    const cmp = result.leaves[0]!.evidence.comparison!;
    expect(cmp.operator).toBe('<');
    expect(cmp.rhs).toBe('1200');
    expect(cmp.passed).toBe(false);
  });

  it('claims 区分事实与未知', async () => {
    const { result: ok } = await evaluate('贵州茅台跌破1200元');
    expect(ok.leaves[0]!.evidence.claims[0]!.type).toBe('fact');

    const chaos = new ChaosAdapter();
    chaos.setScenario('upstream_failure');
    const { result: bad } = await evaluate('贵州茅台跌破1200元', chaos);
    expect(bad.leaves[0]!.evidence.claims[0]!.type).toBe('unknown');
  });

  it('历史指标带出统计窗口口径', async () => {
    const { result } = await evaluate('比亚迪近20日累计涨幅大于1%');
    const obs = result.leaves[0]!.evidence.observations[0]!;
    expect(obs.statisticBasis).toContain('20');
    expect(obs.source.endpoint).toBe('/api/a-share/prices/historical');
  });
});

/**
 * 契约对齐：字段名/容器名必须与扶摇契约一致。
 *
 * 这些用例守护的是一类**特别隐蔽**的 bug：代码读一个契约里不存在的字段，
 * 在回放模式下"看起来能跑"（因为 fixture 是自造的），但真实数据下永远取不到值。
 * 若三值逻辑又把它降级成 unknown，日志里只会看到"无法判定"，功能缺失被掩盖。
 */
describe('契约对齐：读的必须是契约里真实存在的字段', () => {
  it('量比由历史 K 线派生，而不是读快照里不存在的字段', async () => {
    const { result } = await evaluate('贵州茅台量比超过1');
    const leaf = result.leaves[0]!;
    const obs = leaf.evidence.observations[0]!;
    // 扶摇快照契约（PriceSnapshotItem）没有 volume_ratio，必须走历史 K 线派生
    expect(obs.source.endpoint).toBe('/api/a-share/prices/historical');
    expect(leaf.reasonCode).toBe('OK');
    expect(typeof obs.value).toBe('number');
    expect(obs.unit).toBe('RATIO');
    expect(obs.statisticBasis).toContain('平均成交量');
  });

  it('龙虎榜列表取自契约的 data.stock_items', async () => {
    const adapter = new ReplayAdapter();
    const root: Condition = {
      type: 'event',
      id: 'ev1',
      subject: { kind: 'stock', thscode: '600869.SH' },
      source: 'dragon_tiger_list',
      filter: {},
      presence: 'appears',
    };
    const bundle = await bundleFor(root, adapter);
    const result = evaluateRule({
      root,
      taskId: 't1',
      ruleVersionId: 'v1',
      runId: 'r1',
      bundle,
      conflicts: [],
      now: FIXED_NOW,
      subjectName: (c) => names.get(c) ?? c,
    });
    // 600869.SH（远东股份）在 fixture 的 stock_items 里
    expect(result.leaves[0]!.reasonCode).toBe('OK');
    expect(result.truth).toBe(true);
  });

  it('龙虎榜净买入过滤读的是契约字段 net_value', async () => {
    const adapter = new ReplayAdapter();
    const mk = (gte: number): Condition => ({
      type: 'event',
      id: 'ev1',
      subject: { kind: 'stock', thscode: '600869.SH' },
      source: 'dragon_tiger_list',
      filter: { netValueGte: gte },
      presence: 'appears',
    });
    // fixture 里远东股份的 net_value = 264191075.24
    for (const [gte, expected] of [
      [1_0000_0000, true], // 1 亿 < 2.64 亿 → 命中
      [10_0000_0000, false], // 10 亿 > 2.64 亿 → 不命中
    ] as const) {
      const root = mk(gte);
      const bundle = await bundleFor(root, adapter);
      const result = evaluateRule({
        root,
        taskId: 't1',
        ruleVersionId: 'v1',
        runId: 'r1',
        bundle,
        conflicts: [],
        now: FIXED_NOW,
        subjectName: (c) => names.get(c) ?? c,
      });
      expect(result.truth).toBe(expected);
    }
  });

  it('异动标签过滤走请求参数 tag_codes，而不是比对响应里不存在的 tag_code', async () => {
    const root: Condition = {
      type: 'event',
      id: 'ev1',
      subject: { kind: 'stock', thscode: '002815.SZ' },
      source: 'anomaly_analysis_list',
      filter: { tags: ['LIMIT_UP'] },
      presence: 'appears',
    };
    const needs = resolveDataNeeds(root);
    const need = needs.find((n) => n.endpoint.includes('anomaly-analysis-list'))!;
    expect(need).toBeTruthy();
    expect(need.params.tag_codes).toBe('LIMIT_UP');
  });
});

/**
 * 请求参数必须落在契约定义的名字上。
 *
 * 这类 bug 在回放模式下**完全看不出来**（回放只认 thscode/thscodes，其余参数一律忽略），
 * 只有真实调用才会报 `code=1001`。所以只能靠对着契约文本写断言。
 */
describe('契约对齐：请求参数只用契约定义过的名字', () => {
  const priceLeaf = (metric: string, days?: number): Condition => ({
    type: 'price',
    id: 'p1',
    subject: { kind: 'stock', thscode: '600519.SH' },
    metric: metric as any,
    operator: '>',
    value: { kind: 'const', value: 1 },
    ...(days !== undefined ? { window: { days, interval: '1d' as const } } : {}),
  } as Condition);

  it('历史 K 线发 start/end（契约必填），不发契约里不存在的 days', () => {
    const need = resolveDataNeeds(priceLeaf('return_pct_window', 20))[0]!;
    expect(need.endpoint).toBe('/api/a-share/prices/historical');

    expect(need.params.start).toBeDefined();
    expect(need.params.end).toBeDefined();
    expect(need.params).not.toHaveProperty('days');

    const start = Number(need.params.start);
    const end = Number(need.params.end);
    expect(Number.isFinite(start) && Number.isFinite(end)).toBe(true);
    expect(end).toBeGreaterThan(start);
    // 契约：end - start 超过 10 年返回 code=1003
    expect(end - start).toBeLessThanOrEqual(3650 * 86_400_000);
  });

  it('窗口天数超大时被夹到 10 年以内，而不是直接违反契约', () => {
    const need = resolveDataNeeds(priceLeaf('drawdown_from_high_pct', 99_999))[0]!;
    const span = Number(need.params.end) - Number(need.params.start);
    expect(span).toBeLessThanOrEqual(3650 * 86_400_000);
  });

  it('热榜走势发 thscode + start_date/end_date（契约三个都是必填）', () => {
    const root: Condition = {
      type: 'heat',
      id: 'h1',
      subject: { kind: 'stock', thscode: '300750.SZ' },
      source: 'hot_stock_rank_trend',
      metric: 'rank',
      operator: '<=',
      value: { kind: 'const', value: 10 },
      window: { days: 30 },
    } as Condition;

    const need = resolveDataNeeds(root)[0]!;
    expect(need.endpoint).toBe('/api/a-share/special-data/hot-stock-rank-trend');
    expect(need.params.thscode).toBe('300750.SZ');
    // 契约要求 yyyy-MM-dd
    expect(need.params.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(need.params.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // `period` 是热榜列表端点的参数，不该出现在这里
    expect(need.params).not.toHaveProperty('period');
  });

  it('按股票查异动发复数 thscodes，不发单数 thscode', () => {
    const root: Condition = {
      type: 'event',
      id: 'ev2',
      subject: { kind: 'stock', thscode: '600519.SH' },
      source: 'anomaly_analysis_stock',
      filter: {},
      presence: 'appears',
    } as Condition;

    const need = resolveDataNeeds(root)[0]!;
    expect(need.endpoint).toBe('/api/a-share/special-data/anomaly-analysis-stock');
    expect(need.params.thscodes).toBe('600519.SH');
    expect(need.params).not.toHaveProperty('thscode');
  });

  it('不接受标的参数的清单类端点，不再被塞进 thscode', () => {
    for (const source of ['limit_up_pool', 'dragon_tiger_list', 'abnormal_monitor_list'] as const) {
      const root: Condition = {
        type: 'event',
        id: 'ev3',
        subject: { kind: 'stock', thscode: '002815.SZ' },
        source,
        filter: {},
        presence: 'appears',
      } as Condition;

      const need = resolveDataNeeds(root)[0]!;
      expect(need.params).not.toHaveProperty('thscode');
      expect(need.params).not.toHaveProperty('thscodes');
    }
  });

  it('去掉 thscode 后仍然能在完整清单里找到该标的（客户端过滤兜底）', async () => {
    // 崇达技术在涨停池里；参数收窄后由评测器按 thscode 在清单中定位
    const { result } = await evaluate('崇达技术出现涨停');
    expect(result.truth).toBe(true);
  });
});

describe('降级文案必须明确表达"无法判定"', () => {
  it('失败场景的文案含技术细节与 request_id 线索', async () => {
    const chaos = new ChaosAdapter();
    chaos.setScenario('upstream_failure');
    const { result } = await evaluate('贵州茅台跌破1200元', chaos);
    const n = result.leaves[0]!.evidence.narrative;
    expect(n).toContain('无法判定');
    expect(n).toMatch(/5003|上游/);
  });

  it('过期场景的文案含时点与阈值', async () => {
    const chaos = new ChaosAdapter();
    chaos.setScenario('stale_price');
    const { result } = await evaluate('贵州茅台跌破1200元', chaos);
    const n = result.leaves[0]!.evidence.narrative;
    expect(n).toContain('数据过期');
    expect(n).toContain('阈值');
  });
});
