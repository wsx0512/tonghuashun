/**
 * 单位归一化。
 *
 * 为什么需要这个文件：扶摇不同端点的**同义字段用了不同的口径**，这不是 bug，
 * 而是真实契约的一部分（已核实）：
 *
 *   /api/a-share/prices/snapshot   → price_change_ratio_pct = 9.994    （已是百分数）
 *   /api/a-share/special-data/dragon-tiger-list → change = 0.09994     （是小数）
 *
 * 如果不归一化就直接比较，两源会被判为「相差 100 倍」→ 制造**假冲突**，
 * 进而让任务无谓降级。对应测试 TC-C8。
 *
 * 原则：**在数据进入评估层之前完成归一化**，评估层只面对统一口径的数值。
 */

/** 数值 + 单位，归一化后的标准载体 */
export interface Quantity {
  value: number;
  unit: 'CNY' | 'PCT' | 'RATIO' | 'SHARES' | 'CNY_AMOUNT' | 'RANK' | 'DAY';
}

/** 小数比率 → 百分数（0.09994 → 9.994） */
export function ratioToPct(ratio: number): number {
  return Number((ratio * 100).toFixed(6));
}

/** 百分数 → 小数比率（9.994 → 0.09994） */
export function pctToRatio(pct: number): number {
  return Number((pct / 100).toFixed(8));
}

/**
 * 把龙虎榜口径的 `change`（小数）归一化为百分数。
 * 端点在把数据交给评估层之前必须调用它。
 */
export function normalizeDragonTigerChange(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return ratioToPct(raw);
}

/** 东财等外部源常见的「放大 100 倍的整数」还原 */
export function fromScaledInt(raw: unknown, scale = 100): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw / scale;
}

/** 东财成交量单位「手」→ 股 */
export function handsToShares(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw * 100;
}

/** 价格字段的显示精度：A 股 2 位小数 */
export function fmtPrice(v: number | null): string {
  return v === null ? '—' : v.toFixed(2);
}

/** 按单位格式化数值，用于面向用户的结论文案 */
export function fmtQuantity(value: number | null, unit: Quantity['unit']): string {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'CNY':
      return `${value.toFixed(2)} 元`;
    case 'PCT':
      return `${value.toFixed(2)}%`;
    case 'RATIO':
      return `${value.toFixed(2)} 倍`;
    case 'SHARES':
      return `${Math.round(value).toLocaleString('zh-CN')} 股`;
    case 'CNY_AMOUNT':
      return `${(value / 1e8).toFixed(2)} 亿元`;
    case 'RANK':
      return `第 ${Math.round(value)} 名`;
    case 'DAY':
      return `${Math.round(value)} 天`;
  }
}

/**
 * 两个数值是否"实质相同"——考虑浮点误差。
 * 用于避免 1312.97 与 1312.9700000001 被判为冲突。
 */
export function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon * Math.max(1, Math.abs(a), Math.abs(b));
}
