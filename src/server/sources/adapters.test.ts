/**
 * 数据层测试：回放过滤 / 故障注入 / 冲突检测。
 * 对应测试计划 C 组的可确定性部分（TC-C2/C4/C6/C7/C8）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplayAdapter } from './replay.adapter.js';
import { ChaosAdapter } from './chaos.adapter.js';
import { SourceMesh } from './sourceMesh.js';
import { EP } from './types.js';
import { ManualClock, setClock, resetClock } from '../clock.js';
import { assessFreshness } from './envelope.js';
import { normalizeDragonTigerChange, ratioToPct } from '../../shared/units.js';

const FIXED_NOW = Date.parse('2026-10-15T15:05:00+08:00');
const __dirname = dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  setClock(new ManualClock(FIXED_NOW));
});
afterEach(() => {
  resetClock();
});

describe('ReplayAdapter —— 默认数据源', () => {
  it('按 thscodes 参数过滤，而不是无脑返回全量', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({
      endpoint: EP.pricesSnapshot,
      params: { thscodes: '600519.SH' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.data.item).toHaveLength(1);
    expect(r.data.item[0].thscode).toBe('600519.SH');
    expect(r.data.item[0].last_price).toBeCloseTo(1312.97, 2);
  });

  it('多标的过滤', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({
      endpoint: EP.pricesSnapshot,
      params: { thscodes: '600519.SH,000001.SZ' },
    });
    if (!r.ok) throw new Error('unreachable');
    expect(r.data.item.map((x: any) => x.thscode).sort()).toEqual(['000001.SZ', '600519.SH']);
  });

  it('"不在池中"是有效的业务事实，返回空列表而非报错', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({
      endpoint: EP.limitUpPool,
      params: { thscode: '600519.SH' }, // 茅台今天没涨停
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.data.item).toHaveLength(0);
  });

  it('历史 K 线按 thscode 选择对应 fixture', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({
      endpoint: EP.pricesHistorical,
      params: { thscode: '600519.SH', interval: '1d' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.data.item.length).toBeGreaterThan(50);
    expect(r.data.item[0]).toHaveProperty('date_ms');
    expect(r.data.item[0]).toHaveProperty('close_price');
  });

  it('历史端点缺少 thscode → code 1001（缺少必填参数）', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch({ endpoint: EP.pricesHistorical, params: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('UNSUPPORTED');
  });

  it('data.timestamp 被归一化为"刚刚取到"，避免回放数据随时间集体过期', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({ endpoint: EP.pricesSnapshot, params: {} });
    if (!r.ok) throw new Error('unreachable');
    expect(r.dataTimestampMs).toBe(FIXED_NOW);
    expect(assessFreshness(r.dataTimestampMs, 60_000, FIXED_NOW).fresh).toBe(true);
  });

  it('返回的信封带 request_id，供证据回链', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch({ endpoint: EP.pricesSnapshot, params: {} });
    expect(r.requestId).toBeTruthy();
  });
});

describe('ChaosAdapter —— 故障注入的确定性', () => {
  it('TC-C4: upstream_failure → FAILURE', async () => {
    const c = new ChaosAdapter();
    c.setScenario('upstream_failure');
    const r = await c.fetch({ endpoint: EP.pricesSnapshot, params: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('FAILURE');
    expect(r.retryable).toBe(true);
  });

  it('TC-C2: rate_limited → RATE_LIMITED', async () => {
    const c = new ChaosAdapter();
    c.setScenario('rate_limited');
    const r = await c.fetch({ endpoint: EP.pricesSnapshot, params: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('RATE_LIMITED');
  });

  it('TC-C6: stale_price 把数据时点推回 3 小时，过期判定命中', async () => {
    const c = new ChaosAdapter();
    c.setScenario('stale_price');
    const r = await c.fetch<any>({ endpoint: EP.pricesSnapshot, params: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // 数据本身取到了，但时点是 3 小时前
    expect(r.data.item.length).toBeGreaterThan(0);
    const f = assessFreshness(r.dataTimestampMs, 5 * 60 * 1000, FIXED_NOW);
    expect(f.fresh).toBe(false);
    expect(f.ageMs).toBe(3 * 3600 * 1000);
  });

  it('capability_denied → CAPABILITY_DENIED 且不可重试', async () => {
    const c = new ChaosAdapter();
    c.setScenario('capability_denied');
    const r = await c.fetch({ endpoint: EP.newsEventsSearch, params: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('CAPABILITY_DENIED');
    expect(r.retryable).toBe(false);
  });

  it('malformed（网关 HTML 错误页）→ MALFORMED_ENVELOPE', async () => {
    const c = new ChaosAdapter();
    c.setScenario('malformed');
    const r = await c.fetch({ endpoint: EP.pricesSnapshot, params: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('MALFORMED_ENVELOPE');
  });

  it('TC-C9: partial_null 把金额字段置空，**不补零**', async () => {
    const c = new ChaosAdapter();
    c.setScenario('partial_null');
    const r = await c.fetch<any>({ endpoint: EP.pricesSnapshot, params: { thscodes: '600519.SH' } });
    if (!r.ok) throw new Error('unreachable');
    const it = r.data.item[0];
    expect(it.turnover).toBeNull();
    expect(it.total_market_cap).toBeNull();
    // 关键：绝不能是 0——0 会把"没有数据"伪装成"金额为零"
    expect(it.turnover).not.toBe(0);
    // 价格字段不受影响
    expect(it.last_price).toBeCloseTo(1312.97, 2);
  });

  it('场景不匹配的端点不受影响（scope 生效）', async () => {
    const c = new ChaosAdapter();
    c.setScenario('stale_price'); // 只作用于价格类端点
    const r = await c.fetch<any>({ endpoint: EP.limitUpPool, params: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.data.item.length).toBeGreaterThan(0);
  });

  it('clear() 之后恢复正常', async () => {
    const c = new ChaosAdapter();
    c.setScenario('upstream_failure');
    expect((await c.fetch({ endpoint: EP.pricesSnapshot, params: {} })).ok).toBe(false);
    c.clear();
    expect((await c.fetch({ endpoint: EP.pricesSnapshot, params: {} })).ok).toBe(true);
  });
});

describe('SourceMesh —— 冲突检测', () => {
  it('单源模式：不做冲突检测', async () => {
    const mesh = new SourceMesh({ primary: new ReplayAdapter() });
    const out = await mesh.fetch<any>({ endpoint: EP.pricesSnapshot, params: {} });
    expect(out.secondaryUsed).toBe(false);
    expect(out.conflicts).toHaveLength(0);
  });

  it('两源一致时无冲突', async () => {
    const mesh = new SourceMesh({
      primary: new ReplayAdapter(),
      secondary: new ReplayAdapter({ perturbPct: 0 }),
    });
    const out = await mesh.fetch<any>({ endpoint: EP.pricesSnapshot, params: {} });
    expect(out.secondaryUsed).toBe(true);
    expect(out.conflicts).toHaveLength(0);
  });

  it('TC-C7: 两源偏差 0.87% 超过 0.5% 阈值 → 检出冲突，且两个值都保留', async () => {
    const mesh = new SourceMesh({
      primary: new ReplayAdapter(),
      secondary: new ReplayAdapter({ perturbPct: 0.0087 }),
      tolerancePct: 0.005,
    });
    const out = await mesh.fetch<any>({
      endpoint: EP.pricesSnapshot,
      params: { thscodes: '600519.SH' },
    });
    expect(out.conflicts.length).toBeGreaterThan(0);
    const c = out.conflicts[0]!;
    expect(c.field).toBe('last_price');
    expect(c.thscode).toBe('600519.SH');
    // 两个值都在，没有被静默丢弃
    expect(c.valueA).toBeCloseTo(1312.97, 2);
    expect(c.valueB).toBeGreaterThan(c.valueA);
    expect(c.deltaPct).toBeCloseTo(0.0087, 3);
    // 主源数值不被备源替换
    if (!out.primary.ok) throw new Error('unreachable');
    expect(out.primary.data.item[0].last_price).toBeCloseTo(1312.97, 2);
  });

  it('偏差在阈值内不报冲突（避免浮点噪声造成假冲突）', async () => {
    const mesh = new SourceMesh({
      primary: new ReplayAdapter(),
      secondary: new ReplayAdapter({ perturbPct: 0.001 }),
      tolerancePct: 0.005,
    });
    const out = await mesh.fetch<any>({ endpoint: EP.pricesSnapshot, params: {} });
    expect(out.conflicts).toHaveLength(0);
  });

  it('备源失败不污染主源结果（只降级为"无冲突检测"）', async () => {
    const brokenSecondary = {
      name: 'broken',
      mode: 'replay' as const,
      fetch: async () => ({
        ok: false as const,
        reasonCode: 'FAILURE' as const,
        message: 'down',
        userMessage: 'down',
        requestId: null,
        retryable: true,
        raw: {
          id: 'x',
          provider: 'broken',
          endpoint: '',
          requestParams: {},
          httpStatus: 500,
          body: null,
          retrievedAt: 0,
          mode: 'replay' as const,
        },
      }),
    };
    const mesh = new SourceMesh({ primary: new ReplayAdapter(), secondary: brokenSecondary });
    const out = await mesh.fetch<any>({ endpoint: EP.pricesSnapshot, params: { thscodes: '600519.SH' } });
    expect(out.primary.ok).toBe(true);
    expect(out.secondaryUsed).toBe(false);
  });
});

describe('TC-D5: 出站净化 —— 数据源自带的预测性字段必须被丢弃', () => {
  it('龙虎榜的 EXPLAIN 字段含「成功率44.94%」，必须被滤掉', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({ endpoint: EP.dragonTigerList, params: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');

    // 原始 fixture 里确实带着这个字段（这是真实数据源的形态）
    const raw = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'fixtures', 'fuyao', 'dragon_tiger_list.json'),
        'utf8',
      ),
    );
    expect(raw.data.item[0]._source_explain_raw).toContain('成功率');

    // 但经过适配器之后，它不能再出现
    const first = r.data.item[0];
    expect(first._source_explain_raw).toBeUndefined();

    // 且不能有任何字段残留预测性表述
    const flat = JSON.stringify(r.data);
    expect(flat).not.toContain('成功率');
    expect(flat).not.toContain('44.94');

    // 丢弃行为被留痕，可审计
    expect(a.lastDropped.length).toBeGreaterThan(0);
    expect(a.lastDropped[0]!.reason).toContain('成功率');
  });

  it('净化不影响数值字段，数据结构保持完整', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({ endpoint: EP.dragonTigerList, params: {} });
    if (!r.ok) throw new Error('unreachable');
    const first = r.data.item[0];
    expect(typeof first.billboard_net_amt).toBe('number');
    expect(typeof first.change).toBe('number');
    expect(first.name).toBeTruthy();
    expect(r.data.item.length).toBe(50);
  });

  it('正常的文字字段（行业、名称、原因）不被误删', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({ endpoint: EP.limitUpPool, params: {} });
    if (!r.ok) throw new Error('unreachable');
    const first = r.data.item[0];
    expect(first.name).toBeTruthy();
    expect(first.industry).toBeTruthy();
  });
});

describe('TC-C8: 单位口径归一化', () => {
  it('龙虎榜的小数 change 归一化后与价格的百分数口径一致', async () => {
    const a = new ReplayAdapter();
    const r = await a.fetch<any>({
      endpoint: EP.dragonTigerList,
      params: {},
    });
    if (!r.ok) throw new Error('unreachable');
    const item = r.data.item[0];
    // fixture 按扶摇契约存的是小数
    expect(item.change).toBeLessThan(1);
    // 归一化后应落在合理的涨跌幅区间
    const pct = normalizeDragonTigerChange(item.change);
    expect(pct).not.toBeNull();
    expect(Math.abs(pct!)).toBeLessThan(21); // A 股涨跌停 ±20%
    expect(Math.abs(pct!)).toBeGreaterThan(0.01);
  });

  it('若不归一化直接比较，会制造 100 倍的假冲突', () => {
    const dragonTigerChange = 0.09994; // 小数口径
    const priceChangePct = 9.994; // 百分数口径，实为同一涨跌幅
    // 直接比较 → 假冲突
    const naiveDelta = Math.abs(dragonTigerChange - priceChangePct) / Math.max(dragonTigerChange, priceChangePct);
    expect(naiveDelta).toBeGreaterThan(0.5);
    // 归一化后 → 一致
    expect(ratioToPct(dragonTigerChange)).toBeCloseTo(priceChangePct, 6);
  });
});
