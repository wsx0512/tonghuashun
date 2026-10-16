/**
 * 数据源适配器接口。
 *
 * 三种模式共用同一个接口，因此上层（评估器、调度器）完全不需要知道
 * 数据是来自真实扶摇、回放 fixture 还是故障注入。
 */

import type { SourceResult } from './envelope.js';

export type AdapterMode = 'live' | 'replay' | 'chaos';

export interface SourceRequest {
  /** 逻辑端点，形如 '/api/a-share/prices/snapshot' */
  endpoint: string;
  params: Record<string, string>;
}

export interface SourceAdapter {
  readonly name: string;
  readonly mode: AdapterMode;
  fetch<T = unknown>(req: SourceRequest): Promise<SourceResult<T>>;
}

/** 扶摇端点常量 —— 全系统引用这里，避免各处硬编码字符串拼错 */
export const EP = {
  pricesSnapshot: '/api/a-share/prices/snapshot',
  pricesHistorical: '/api/a-share/prices/historical',
  valuationsSnapshot: '/api/a-share/valuations/snapshot',
  tradingDays: '/api/a-share/calendar/trading-days',
  hotStockList: '/api/a-share/special-data/hot-stock-list',
  hotStockRankTrend: '/api/a-share/special-data/hot-stock-rank-trend',
  limitUpPool: '/api/a-share/special-data/limit-up-pool',
  limitDownPool: '/api/a-share/special-data/limit-down-pool',
  limitBreakPool: '/api/a-share/special-data/limit-break-pool',
  limitUpLadder: '/api/a-share/special-data/limit-up-ladder',
  dragonTigerList: '/api/a-share/special-data/dragon-tiger-list',
  anomalyAnalysisList: '/api/a-share/special-data/anomaly-analysis-list',
  anomalyAnalysisStock: '/api/a-share/special-data/anomaly-analysis-stock',
  abnormalMonitorList: '/api/a-share/special-data/abnormal-monitor-list',
  tickerSearch: '/api/meta/tickers/search',
  /**
   * ⚠️ 该端点已核实标注「该能力暂未开放外部接入」。
   * 保留在代码里不是为了使用，而是为了让它成为 CAPABILITY_DENIED 降级场景的
   * **真实依据**——而不是凭空捏造一个失败场景。
   */
  newsEventsSearch: '/api/news/events/search',
} as const;

/**
 * 已核实「暂未开放外部接入」的能力清单（扶摇文档中该措辞出现 8 次）。
 * 规则校验会据此给出 warning，适配器则会在真实模式下直接返回 CAPABILITY_DENIED。
 */
export const UNAVAILABLE_CAPABILITIES: { endpointPrefix: string; label: string }[] = [
  { endpointPrefix: '/api/news/events', label: '资讯事件库' },
  { endpointPrefix: '/api/a-share/capital-flow', label: '主力资金' },
  { endpointPrefix: '/api/a-share/special-data/chip-shape', label: '同花顺筹码形态' },
  { endpointPrefix: '/api/a-share/high-frequency', label: '高频动向' },
  { endpointPrefix: '/api/a-share/special-data/turnover-prediction', label: '市场成交额预测' },
  { endpointPrefix: '/api/a-share-index/baseinfo/new-concepts', label: '同花顺新增概念' },
  { endpointPrefix: '/api/fund/etf-flow', label: '宽基ETF申购净流入' },
  { endpointPrefix: '/api/futures/fundamentals', label: '期货F10宏观指标' },
];

/**
 * 各端点把记录列表放在 `data` 下的哪个键。
 *
 * 绝大多数端点是 `item`，但**龙虎榜不是**：契约返回 `data.stock_items`
 * （另附 `data.hot_money_items`）。早先按 `item` 读取，真实数据下会取到空数组，
 * 于是"登上龙虎榜"会被静默判成 false —— 正是本项目最要避免的那种错误。
 */
export const LIST_KEY: Record<string, string> = {
  [EP.dragonTigerList]: 'stock_items',
};

/** 该端点的列表在 data 下的键名（默认 `item`） */
export function listKeyFor(endpoint: string): string {
  return LIST_KEY[endpoint] ?? 'item';
}

export function isUnavailable(endpoint: string): { label: string } | null {
  const hit = UNAVAILABLE_CAPABILITIES.find((c) => endpoint.startsWith(c.endpointPrefix));
  return hit ? { label: hit.label } : null;
}
