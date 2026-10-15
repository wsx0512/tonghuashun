/**
 * 自然语言解析测试 —— 对应测试计划 A 组与 D 组。
 *
 * 这组用例同时是 README 中「承诺子集」的可执行定义：
 * 这里断言支持的，README 才敢说支持；这里断言拒绝的，就是明示的边界。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNaturalLanguage, leaves, type CatalogEntry } from './parser.js';
import { resetNodeIds } from './parser.js';
import type { PriceLeaf, EventLeaf, HeatLeaf } from '../../shared/dsl/types.js';
import { subjectCode } from '../../shared/dsl/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog: CatalogEntry[] = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'fixtures', 'catalog.json'), 'utf8'),
).instruments;

beforeEach(() => {
  resetNodeIds();
});

const parse = (s: string) => parseNaturalLanguage(s, catalog);

describe('价格条件', () => {
  it('「贵州茅台跌破1200元」→ last_price < 1200', () => {
    const r = parse('贵州茅台跌破1200元');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as PriceLeaf[];
    expect(l).toHaveLength(1);
    expect(l[0]!.type).toBe('price');
    expect(l[0]!.metric).toBe('last_price');
    expect(l[0]!.operator).toBe('<');
    expect(l[0]!.value).toEqual({ kind: 'const', value: 1200, unit: 'CNY' });
    expect(subjectCode(l[0]!.subject)).toBe('600519.SH');
  });

  it('「贵州茅台涨幅超过5%」→ price_change_ratio_pct >= 5', () => {
    const r = parse('贵州茅台涨幅超过5%');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as PriceLeaf[];
    expect(l[0]!.metric).toBe('price_change_ratio_pct');
    expect(l[0]!.operator).toBe('>=');
    expect(l[0]!.value).toEqual({ kind: 'const', value: 5, unit: 'PCT' });
  });

  it('「贵州茅台跌超3%」→ 负向涨跌幅（取负号）', () => {
    const r = parse('贵州茅台跌超3%');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as PriceLeaf[];
    expect(l[0]!.metric).toBe('price_change_ratio_pct');
    expect(l[0]!.operator).toBe('<=');
    expect(l[0]!.value).toEqual({ kind: 'const', value: -3, unit: 'PCT' });
  });

  it('「宁德时代回撤超过10%」→ drawdown_from_high_pct', () => {
    const r = parse('宁德时代回撤超过10%');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as PriceLeaf[];
    expect(l[0]!.metric).toBe('drawdown_from_high_pct');
    expect(l[0]!.operator).toBe('>=');
  });

  it('「比亚迪近20日累计涨幅大于15%」→ return_pct_window(days=20)', () => {
    const r = parse('比亚迪近20日累计涨幅大于15%');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as PriceLeaf[];
    expect(l[0]!.metric).toBe('return_pct_window');
    expect(l[0]!.window).toEqual({ days: 20, interval: '1d' });
  });

  it('中文数字：「贵州茅台跌破一千二百元」', () => {
    const r = parse('贵州茅台跌破一千二百元');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as PriceLeaf[];
    expect(l[0]!.value).toEqual({ kind: 'const', value: 1200, unit: 'CNY' });
  });
});

describe('逻辑组合', () => {
  it('「A 或者 B」→ OR 两个叶子', () => {
    const r = parse('贵州茅台跌破1200元 或者 涨幅超过5%');
    if (!r.ok) throw new Error('unreachable');
    expect(r.root.type).toBe('or');
    expect(leaves(r.root)).toHaveLength(2);
  });

  it('「A 并且 B」→ AND 两个叶子', () => {
    const r = parse('贵州茅台跌破1200元 并且 涨幅超过5%');
    if (!r.ok) throw new Error('unreachable');
    expect(r.root.type).toBe('and');
    expect(leaves(r.root)).toHaveLength(2);
  });

  it('「(A 或 B) 并且 C」→ AND(OR(A,B), C)，括号覆盖默认优先级', () => {
    const r = parse('（贵州茅台跌破1200元 或者 涨幅超过5%）并且 出现涨停异动');
    if (!r.ok) throw new Error('unreachable');
    expect(r.root.type).toBe('and');
    const ch = (r.root as any).children;
    expect(ch).toHaveLength(2);
    expect(ch[0].type).toBe('or');
    expect(leaves(r.root)).toHaveLength(3);
  });

  it('同一句出现多个标的时全部识别', () => {
    const r = parse('贵州茅台跌破1200元 或者 宁德时代跌破200元');
    if (!r.ok) throw new Error('unreachable');
    const codes = r.scope.subjects.map((s) => subjectCode(s)).sort();
    expect(codes).toEqual(['300750.SZ', '600519.SH']);
  });
});

describe('事件 / 热度 / 日历条件', () => {
  it('「出现涨停异动」→ event（且事件源必须是**可用**端点）', () => {
    const r = parse('贵州茅台出现涨停');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as EventLeaf[];
    expect(l[0]!.type).toBe('event');
    expect(l[0]!.source).toBe('limit_up_pool');
    // 关键：绝不能落到 news_events_search —— 该能力未开放外部接入
    expect(l[0]!.source).not.toBe('news_events_search');
  });

  it('「连续2天涨停」→ minContinueDayCnt = 2', () => {
    const r = parse('贵州茅台连续2天涨停');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as EventLeaf[];
    expect(l[0]!.filter.minContinueDayCnt).toBe(2);
  });

  it('「登上龙虎榜」→ dragon_tiger_list', () => {
    const r = parse('贵州茅台登上龙虎榜');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as EventLeaf[];
    expect(l[0]!.source).toBe('dragon_tiger_list');
  });

  it('「被列入重点监控」→ abnormal_monitor_list', () => {
    const r = parse('贵州茅台被列入重点监控');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as EventLeaf[];
    expect(l[0]!.source).toBe('abnormal_monitor_list');
  });

  it('「进入热榜前10」→ heat in_top_n 10', () => {
    const r = parse('贵州茅台进入热榜前10');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root) as HeatLeaf[];
    expect(l[0]!.type).toBe('heat');
    expect(l[0]!.metric).toBe('in_top_n');
    expect(l[0]!.value).toEqual({ kind: 'const', value: 10, unit: 'RANK' });
  });

  it('「每个交易日」→ calendar is_trading_day', () => {
    const r = parse('贵州茅台 每个交易日');
    if (!r.ok) throw new Error('unreachable');
    const l = leaves(r.root);
    expect(l[0]!.type).toBe('calendar');
  });
});

describe('TC-D1: 合规边界 —— 预测与建议类意图必须被拒绝', () => {
  const forbidden = [
    '贵州茅台会涨吗',
    '茅台什么时候买入',
    '现在要不要卖宁德时代',
    '贵州茅台能涨到多少',
    '给我推荐一只股票',
    '茅台的止盈位是多少',
    '应该买茅台吗',
    '茅台能赚多少',
  ];

  for (const s of forbidden) {
    it(`拒绝：「${s}」`, () => {
      const r = parse(s);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.kind).toBe('compliance');
      expect(r.complianceLabel).toBeTruthy();
      // 拒绝话术必须说明产品能做什么，而不是干巴巴地说"不行"
      expect(r.message).toContain('监控');
    });
  }

  it('拒绝时不产出任何规则', () => {
    const r = parse('茅台会涨吗');
    expect(r.ok).toBe(false);
    expect((r as any).root).toBeUndefined();
  });
});

describe('能力边界 —— 诚实报告"做不到"，而不是猜', () => {
  it('主观描述 → 明确说明无法转成客观条件', () => {
    const r = parse('贵州茅台走势健康');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.kind).toBe('no_condition');
    expect(r.message).toContain('主观');
    // 要给出可行的替代说法
    expect(r.message).toContain('例如');
  });

  it('缺少标的 → 提示补充标的', () => {
    const r = parse('跌破1200元');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('标的');
  });

  it('无阈值无事件 → 提示给出明确条件', () => {
    const r = parse('关注一下贵州茅台');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.kind).toBe('no_condition');
  });
});

describe('命中片段回链（可检查性）', () => {
  it('解析结果能定位到原文中的标的', () => {
    const r = parse('贵州茅台跌破1200元');
    if (!r.ok) throw new Error('unreachable');
    expect(r.scope.subjects[0]!.name).toBe('贵州茅台');
  });

  it('置信度在合理区间', () => {
    const r = parse('贵州茅台跌破1200元');
    if (!r.ok) throw new Error('unreachable');
    expect(r.meta.confidence).toBeGreaterThan(0.3);
    expect(r.meta.confidence).toBeLessThanOrEqual(1);
  });
});

describe('标的歧义 —— ticker 不是唯一键', () => {
  it('000001.SH 与 000001.SZ 是不同标的，按代码能分别解析', () => {
    const r1 = parse('000001.SZ跌破10元');
    const r2 = parse('000001.SH跌破3500点');
    if (!r1.ok || !r2.ok) throw new Error('unreachable');
    expect(subjectCode(r1.scope.subjects[0]!)).toBe('000001.SZ');
    expect(subjectCode(r2.scope.subjects[0]!)).toBe('000001.SH');
  });
});
