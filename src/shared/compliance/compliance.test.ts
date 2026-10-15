/**
 * 合规测试 —— 对应测试计划 D 组（TC-D2 ~ TC-D6）。
 *
 * 这些用例的价值在于：它们**穷举**了所有模板形态，因此将来任何人往模板里
 * 加一句"预计上涨"，CI 会立刻变红，而不是等到评审看到那句文案。
 */

import { describe, it, expect } from 'vitest';
import { scan, isCompliant, assertCompliant, ComplianceViolationError, BANNED_WORDS } from './banned.js';
import { allTemplateSamples, render, templateRecovered } from './templates.js';

describe('TC-D2: 全部模板产出的文案必须零违规', () => {
  const samples = allTemplateSamples();

  it('样本覆盖了模板库的全部形态', () => {
    expect(samples.length).toBeGreaterThanOrEqual(17);
  });

  for (const s of samples) {
    it(`「${s.label}」无违规：${s.text.slice(0, 40)}…`, () => {
      const v = scan(s.text);
      expect(v, `违规项：${v.map((x) => x.label).join('、')}`).toHaveLength(0);
    });
  }

  it('所有事实型文案不含将来时表述', () => {
    for (const s of samples) {
      // 只检查结论句，降级文案里的"已按退避策略延后重试"是描述已采取的动作
      if (s.label.startsWith('degraded/')) continue;
      expect(s.text).not.toMatch(/(将|会|即将|预计)[^，。；]{0,6}(涨|跌|上行|下行)/);
    }
  });

  it('结论句不出现祈使句买卖建议', () => {
    for (const s of samples) {
      expect(s.text).not.toMatch(/(建议|应该|应当|可以)[^，。；]{0,6}(买|卖|加仓|减仓)/);
    }
  });
});

describe('TC-D3: 越界文案必须被拦下（证明过滤器有效，而不是形同虚设）', () => {
  const violations = [
    '贵州茅台预计将上涨至 1500 元。',
    '建议买入贵州茅台。',
    '该股后市有望翻倍。',
    '宁德时代可以买，稳赚。',
    '目标价 2000 元。',
    '上涨概率为 80%。',
    '应该加仓比亚迪。',
    '该标的必涨。',
  ];

  for (const t of violations) {
    it(`拦截：「${t}」`, () => {
      expect(isCompliant(t)).toBe(false);
      expect(scan(t).length).toBeGreaterThan(0);
    });
  }

  it('assertCompliant 抛错并携带违规明细', () => {
    expect(() => assertCompliant('建议买入贵州茅台，预计翻倍', 'test')).toThrow(
      ComplianceViolationError,
    );
    try {
      assertCompliant('建议买入贵州茅台', 'test');
    } catch (e) {
      const err = e as ComplianceViolationError;
      expect(err.violations.length).toBeGreaterThan(0);
      expect(err.original).toContain('建议买入');
    }
  });

  it('合法的事实陈述不被误伤', () => {
    const ok = [
      '贵州茅台 当前值 1312.97 元，高于阈值 1200.00 元（数据时点 2026-10-15 15:00）。',
      '崇达技术 于 2026-10-15 出现涨停。',
      '2026-10-15 是交易日。',
      '本期已按退避策略延后重试。',
      '今日两市成交额 1.2 万亿元。',
      '本次评估暂缓，不会被误判为未触发。',
    ];
    for (const t of ok) {
      expect(scan(t), `误伤：${t}`).toHaveLength(0);
    }
  });
});

describe('TC-D6: 降级文案在语义上与事实陈述可区分', () => {
  it('unknown 级结论必须显式说明"无法判定"', () => {
    const degraded = render({
      kind: 'price',
      status: 'unknown',
      reasonCode: 'STALE',
      slots: { name: '贵州茅台', asOf: '2026-10-15 09:30' },
      degradedDetail: '数据时点距今 12 分钟，超过阈值 5 分钟',
    });
    expect(degraded).toContain('无法判定');
    expect(degraded).not.toMatch(/未触发|正常/);
  });

  it('降级文案不得被误读为"条件未满足"', () => {
    const d = render({
      kind: 'price',
      status: 'unknown',
      reasonCode: 'NOT_READY',
      slots: { name: '崇达技术' },
      degradedDetail: '当日异动数据尚未生成',
    });
    // 必须出现"不等于"这类澄清
    expect(d).toMatch(/不等于|无法判定/);
  });

  it('恢复文案只陈述"条件已解除"这一事实', () => {
    const t = templateRecovered({ name: '贵州茅台', asOf: '2026-10-15 15:00' }, '跌破 1200 元');
    expect(t).toContain('已解除');
    expect(scan(t)).toHaveLength(0);
    // 不得暗示后续走势
    expect(t).not.toMatch(/将继续|后市|反弹|回升/);
  });
});

describe('禁用词表本身的自检', () => {
  it('词表非空且无重复', () => {
    expect(BANNED_WORDS.length).toBeGreaterThan(20);
    expect(new Set(BANNED_WORDS).size).toBe(BANNED_WORDS.length);
  });
});
