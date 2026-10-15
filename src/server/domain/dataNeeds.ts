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

/** 快照即可取到的价格指标 */
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
  'volume_ratio',
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
      if (leaf.metric === 'close_price' || leaf.metric === 'return_pct_window' || leaf.metric === 'drawdown_from_high_pct') {
        return {
          endpoint: EP.pricesHistorical,
          // 该端点契约要求单只标的、且不接受逗号
          params: {
            thscode,
            interval: '1d',
            adjust: 'forward',
            days: String(leaf.window?.days ?? 60),
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

    case 'event':
      return {
        endpoint: EVENT_ENDPOINT[leaf.source] ?? EP.anomalyAnalysisList,
        params: { thscode: subjectThscode(leaf.subject) },
        leafIds: [leaf.id],
      };

    case 'heat':
      return {
        endpoint:
          leaf.source === 'hot_stock_rank_trend'
            ? EP.hotStockRankTrend
            : EP.hotStockList,
        params: {
          thscode: subjectThscode(leaf.subject),
          ...(leaf.period ? { period: leaf.period } : {}),
        },
        leafIds: [leaf.id],
      };

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
