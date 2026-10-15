/**
 * 数据新鲜度策略。
 *
 * 核心原则：**锚定上游的 data.timestamp，不是本地取数时刻。**
 * 「响应是刚刚收到的」不代表「数据是新的」——上游可能一直在返回几小时前的快照。
 *
 * 另一个容易做错的地方：非交易时段不能用盘中阈值（60 秒）。
 * 收盘后价格数据天然是"几小时前"的，若沿用盘中阈值会**天天误报过期**，
 * 用户很快就不信任告警了。所以闭市后改用「以最近交易日收盘为基准」。
 */

import { EP } from '../sources/types.js';

/** 盘中阈值（毫秒） */
const INTRADAY_MS: Record<string, number> = {
  [EP.pricesSnapshot]: 60_000, // 盘中快照 1 分钟
  [EP.hotStockList]: 2 * 3600_000, // 热榜按小时更新
  [EP.anomalyAnalysisList]: 2 * 3600_000, // 异动解读当日有效
};

/** 跨日阈值（毫秒）——这些数据本来就是按日更新的 */
const DAILY_MS: Record<string, number> = {
  [EP.pricesHistorical]: 5 * 24 * 3600_000, // 最近交易日即可
  [EP.valuationsSnapshot]: 7 * 24 * 3600_000, // 估值按财报更新
  [EP.limitUpPool]: 5 * 24 * 3600_000,
  [EP.limitDownPool]: 5 * 24 * 3600_000,
  [EP.limitBreakPool]: 5 * 24 * 3600_000,
  [EP.limitUpLadder]: 5 * 24 * 3600_000,
  [EP.dragonTigerList]: 5 * 24 * 3600_000,
  [EP.abnormalMonitorList]: 5 * 24 * 3600_000,
  [EP.tradingDays]: 40 * 24 * 3600_000,
};

const DEFAULT_MS = 4 * 3600_000;

/** A 股交易时段（Asia/Shanghai）：09:30–11:30、13:00–15:00 */
export function isTradingHours(nowMs: number): boolean {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false; // 周末（节假日由交易日历另行判断）
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
}

/**
 * 取某个端点在当前时刻的过期阈值。
 *
 * 价格快照在**闭市后**放宽到「到最近一次收盘为止」：只要数据时点不早于
 * 今天（或上一交易日）15:00，就算新鲜。
 */
export function effectiveThresholdMs(endpoint: string, nowMs: number): number {
  const intraday = INTRADAY_MS[endpoint];
  if (intraday !== undefined) {
    if (isTradingHours(nowMs)) return intraday;
    // 闭市后：允许用到当日收盘
    return msSinceLastClose(nowMs) + 30 * 60_000;
  }
  return DAILY_MS[endpoint] ?? DEFAULT_MS;
}

/**
 * 距离最近一次收盘过了多久。
 *
 * 15:00 Asia/Shanghai == 07:00 UTC，所以当天收盘时刻就是
 * Date.UTC(y, m, d, 7, 0, 0)。**不要再额外减 8 小时**——
 * 那会把"收盘"错算成当天早上 7 点，使闭市后的过期阈值虚高约 8 小时，
 * 于是几小时前的旧数据会被误判为新鲜（这个坑测试抓到过）。
 */
function msSinceLastClose(nowMs: number): number {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  const closeMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0, 0);
  if (nowMs >= closeMs) return nowMs - closeMs;
  // 尚未到今日收盘：以昨日收盘为基准
  return nowMs - (closeMs - 24 * 3600_000);
}

/** 供测试与 UI 展示：阈值的人类可读描述 */
export function describeThreshold(ms: number): string {
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 24 * 3600_000) return `${Math.round(ms / 3600_000)} 小时`;
  return `${Math.round(ms / (24 * 3600_000))} 天`;
}
