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
