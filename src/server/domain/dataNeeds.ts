/**
 * 规则 → 数据需求。
 *
 * 叶子节点不直接调数据源，而是声明「我需要什么」。这一步同时服务三个目的：
 *  1. **可检查性**：用户能看见每条规则会去打哪些接口、带什么参数
 *  2. **批量合并**：同一 tick 内多个任务对同一端点同一参数的请求可以合并成一次调用，
 *     从源头降低限流风险
 *  3. **降级归因**：某个端点数失败时，能精确定位到受影响的叶子
 */

import type { Condition, DataNeed, Leaf } from '../../shared/dsl/types.js';
import { EP } from '../sources/types.js';
import { getClock } from '../clock.js';

const DAY_MS = 86_400_000;

/** 契约要求历史 K 线的 [start, end] 跨度不超过 10 年，超过返回 code=1003 */
const MAX_HISTORY_DAYS = 3650;

/**
 * 历史 K 线的 [start, end] 窗口。
 *
 * 契约把 `start` / `end` **都标为必需**（long，毫秒时间戳），缺失即 `code=1001`。
 * 早先代码发的是一个契约里**根本不存在**的 `days` 参数 —— 回放模式下看不出来，
 * 真实调用必然报错。这里按契约的形态构造。
 */
function historyWindow(days: number, nowMs: number): Record<string, string> {
  const n = Math.min(Math.max(Math.trunc(days), 1), MAX_HISTORY_DAYS);
  return { start: String(nowMs - n * DAY_MS), end: String(nowMs) };
}

/** `yyyy-MM-dd`（Asia/Shanghai）—— 契约对日期型入参要求的正是这个格式 */
function shanghaiDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/**
 * 快照即可取到的价格指标。
 *
 * ⚠️ `volume_ratio`（量比）**不在**这里：扶摇的快照契约（`PriceSnapshotItem`）
 * 并不提供该字段，它必须由历史 K 线派生。详见下方 historical 分支的说明。
 */
const SNAPSHOT_METRICS = new Set([
  'last_price',
  'price_change',
  'price_change_ratio_pct',
  'open_price',
  'high_price',
  'low_price',
  'prev_price',
  'volume',
  'turnover',
]);

/** 事件源 → 端点 */
const EVENT_ENDPOINT: Record<string, string> = {
  anomaly_analysis_list: EP.anomalyAnalysisList,
  anomaly_analysis_stock: EP.anomalyAnalysisStock,
  abnormal_monitor_list: EP.abnormalMonitorList,
  dragon_tiger_list: EP.dragonTigerList,
  limit_up_pool: EP.limitUpPool,
  limit_down_pool: EP.limitDownPool,
  limit_break_pool: EP.limitBreakPool,
  limit_up_ladder: EP.limitUpLadder,
  news_events_search: EP.newsEventsSearch,
};

/**
 * 这些端点的数据是**完整清单**：某标的不在清单里，是一个有意义的业务事实
 * （例如"今天没有涨停"）。因此"查不到"判定为 false。
 *
 * 而快照类端点的数据是**按标的取值**：查不到某个标的意味着拿不到数据，
 * 必须判定为 unknown —— 绝不能当成 false，那正是"静默生成正常结论"。
 */
export const MEMBERSHIP_ENDPOINTS = new Set<string>([
  EP.limitUpPool,
  EP.limitDownPool,
  EP.limitBreakPool,
  EP.limitUpLadder,
  EP.dragonTigerList,
  EP.anomalyAnalysisList,
  EP.abnormalMonitorList,
]);

export function isMembershipEndpoint(endpoint: string): boolean {
  return MEMBERSHIP_ENDPOINTS.has(endpoint);
}

/** 收集条件树中的所有叶子 */
export function collectLeaves(c: Condition): Leaf[] {
  if (c.type === 'and' || c.type === 'or') return c.children.flatMap(collectLeaves);
  if (c.type === 'not') return collectLeaves(c.child);
  return [c];
}

/** 单个叶子需要哪个端点、带什么参数 */
export function leafDataNeed(leaf: Leaf): DataNeed {
  switch (leaf.type) {
    case 'price': {
      const thscode = subjectThscode(leaf.subject);
      // 这些指标需要历史 K 线而非快照：
      //  - close_price / return_pct_window：本身就要一段序列
      //  - drawdown_from_high_pct：要区间最高价
      //  - volume_ratio：**扶摇快照不提供量比**，只能由「当日量 ÷ 近 N 日均量」派生
      if (
        leaf.metric === 'close_price' ||
        leaf.metric === 'return_pct_window' ||
        leaf.metric === 'drawdown_from_high_pct' ||
        leaf.metric === 'volume_ratio'
      ) {
        return {
          endpoint: EP.pricesHistorical,
          // 该端点契约要求单只标的、且不接受逗号
          params: {
            thscode,
            interval: '1d',
            adjust: 'forward',
            ...historyWindow(leaf.window?.days ?? 60, getClock().now()),
          },
          leafIds: [leaf.id],
        };
      }
      return {
        endpoint: EP.pricesSnapshot,
        params: { thscodes: thscode },
        leafIds: [leaf.id],
      };
    }

    case 'event': {
      const endpoint = EVENT_ENDPOINT[leaf.source] ?? EP.anomalyAnalysisList;
      const thscode = subjectThscode(leaf.subject);

      /*
       * 只发**契约定义过**的参数。
       *
       * 早先对所有事件端点统一塞 `thscode`，但契约里只有「按股票查异动」
       * 接受标的参数，且要求的是**复数** `thscodes`；涨跌停池 / 龙虎榜 /
       * 异动监控等端点都不接受标的参数（它们是"整份清单"语义，客户端过滤）。
       * 发一个契约没定义的参数，在真实调用下会被判为非法入参。
       */
      if (endpoint === EP.anomalyAnalysisStock) {
        return { endpoint, params: { thscodes: thscode }, leafIds: [leaf.id] };
      }
      if (endpoint === EP.anomalyAnalysisList) {
        /**
         * 异动标签过滤走**请求参数** `tag_codes`，不是客户端过滤：
         * 响应记录里没有标签代码字段，只有展示名 `tag_name`。
         * 标签代码（`LIMIT_UP` 等）是请求侧的概念，由服务端过滤。
         */
        const tagCodes = leaf.filter?.tags?.length ? leaf.filter.tags.join(',') : null;
        return {
          endpoint,
          params: tagCodes ? { tag_codes: tagCodes } : {},
          leafIds: [leaf.id],
        };
      }
      return { endpoint, params: {}, leafIds: [leaf.id] };
    }

    case 'heat': {
      const thscode = subjectThscode(leaf.subject);

      if (leaf.source === 'hot_stock_rank_trend') {
        /*
         * 该端点的契约入参是 `thscode` + **必填的** `start_date` / `end_date`
         * （`yyyy-MM-dd`）。早先发的是 `period` —— 那是热榜列表端点的参数，
         * 用在这里会被判为非法入参，同时缺了两个必填项。
         */
        const days = leaf.window?.days ?? 30;
        const nowMs = getClock().now();
        return {
          endpoint: EP.hotStockRankTrend,
          params: {
            thscode,
            start_date: shanghaiDay(nowMs - (days - 1) * DAY_MS),
            end_date: shanghaiDay(nowMs),
          },
          leafIds: [leaf.id],
        };
      }

      // 热榜列表端点：`period`（可选）+ `limit`，不接受 thscode
      return {
        endpoint: EP.hotStockList,
        params: { ...(leaf.period ? { period: leaf.period } : {}) },
        leafIds: [leaf.id],
      };
    }

    case 'calendar':
      return {
        endpoint: EP.tradingDays,
        params: {},
        leafIds: [leaf.id],
      };
  }
}

/**
 * 把整棵规则树解析为**去重合并后**的数据需求列表。
 * 同一 (端点, 参数) 只出现一次，leafIds 汇总所有需要它的叶子。
 */
export function resolveDataNeeds(root: Condition): DataNeed[] {
  const needs = collectLeaves(root).map(leafDataNeed);
  const merged = new Map<string, DataNeed>();

  for (const n of needs) {
    const key = `${n.endpoint}?${canonicalParams(n.params)}`;
    const existing = merged.get(key);
    if (existing) {
      existing.leafIds.push(...n.leafIds);
    } else {
      merged.set(key, { ...n, leafIds: [...n.leafIds] });
    }
  }
  return [...merged.values()];
}

/** 参数规范化：键排序，保证同一组参数产出同一个 key */
export function canonicalParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function subjectThscode(s: { kind: string; thscode?: string; id?: string }): string {
  return s.thscode ?? s.id ?? '';
}

/**
 * 跨任务合并数据需求：一个 tick 内所有到期任务的请求合并成一批。
 * 返回按 (端点, 参数) 去重后的请求列表，并记录每个请求服务于哪些叶子。
 */
export function mergeAcrossTasks(
  perTask: { taskId: string; needs: DataNeed[] }[],
): Map<string, { endpoint: string; params: Record<string, string>; consumers: { taskId: string; leafId: string }[] }> {
  const out = new Map<
    string,
    { endpoint: string; params: Record<string, string>; consumers: { taskId: string; leafId: string }[] }
  >();

  for (const { taskId, needs } of perTask) {
    for (const n of needs) {
      const key = `${n.endpoint}?${canonicalParams(n.params)}`;
      let entry = out.get(key);
      if (!entry) {
        entry = { endpoint: n.endpoint, params: n.params, consumers: [] };
        out.set(key, entry);
      }
      for (const leafId of n.leafIds) entry.consumers.push({ taskId, leafId });
    }
  }
  return out;
}
