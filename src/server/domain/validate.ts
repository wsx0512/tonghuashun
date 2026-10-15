/**
 * 规则语义校验 —— 「可检查」的第二层。
 *
 * 第一层是 schema.ts 的 Zod 结构校验（字段名、类型、枚举）。
 * 这一层管跨字段的语义：算子与单位是否匹配、标的类型是否支持该指标、
 * 窗口是否越界、以及**是否会长期处于降级态**。
 *
 * 输出分 errors（阻断保存）与 warnings（允许保存但要让用户知道）。
 * 特别是「该数据能力未开放外部接入」——这是 warning 而非 error：
 * 用户有权保存一个注定降级的规则，但他必须先知道这件事。
 */

import type { Condition, Leaf, Scope, Unit, Comparator } from '../../shared/dsl/types.js';
import type { CatalogEntry } from '../nl/parser.js';
import { isUnavailable } from '../sources/types.js';
import { subjectCode } from '../../shared/dsl/types.js';
import { collectLeaves, leafDataNeed } from './dataNeeds.js';

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

/** 指标 → 期望单位（与 z 的 unit 必须一致，否则会出现"5 元 > 3%"这种无意义比较） */
const METRIC_UNIT: Record<string, Unit> = {
  last_price: 'CNY',
  close_price: 'CNY',
  open_price: 'CNY',
  high_price: 'CNY',
  low_price: 'CNY',
  prev_price: 'CNY',
  price_change: 'CNY',
  price_change_ratio_pct: 'PCT',
  return_pct_window: 'PCT',
  drawdown_from_high_pct: 'PCT',
  volume: 'SHARES',
  turnover: 'CNY_AMOUNT',
  volume_ratio: 'RATIO',
  rank: 'RANK',
  rank_change: 'RANK',
  heat: 'RATIO',
  in_top_n: 'RANK',
};

/** 指数不支持的指标（指数没有"封板资金"这类个股概念） */
const INDEX_UNSUPPORTED_METRICS = new Set<string>([]);

export function validateRule(root: Condition, scope: Scope, catalog: CatalogEntry[]): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byCode = new Map(catalog.map((c) => [c.thscode, c]));
  const byTicker = new Map<string, CatalogEntry[]>();
  for (const c of catalog) {
    if (!byTicker.has(c.ticker)) byTicker.set(c.ticker, []);
    byTicker.get(c.ticker)!.push(c);
  }

  // ── 作用域 ──
  if (scope.subjects.length === 0) {
    errors.push('规则没有指定任何监控标的。');
  }
  for (const s of scope.subjects) {
    if (s.kind === 'watchlist') {
      warnings.push(`关注池「${s.name ?? s.id}」当前以静态清单展开，暂不支持动态增删成员。`);
      continue;
    }
    const code = s.thscode;
    if (!byCode.has(code)) {
      const ambiguous = byTicker.get(code.split('.')[0] ?? '');
      if (ambiguous && ambiguous.length > 1) {
        errors.push(
          `标的「${code}」存在歧义，可能是 ${ambiguous.map((a) => `${a.name}(${a.thscode})`).join(' 或 ')}，请写明市场后缀。`,
        );
      } else {
        errors.push(`标的「${code}」不在可用标的中。`);
      }
      continue;
    }
    if (scope.quantifier === 'aggregate') {
      warnings.push('聚合量化方式本版本按「全部满足」处理，尚未实现加权聚合。');
    }
  }

  // ── 叶子 ──
  const leaves = collectLeaves(root);
  if (leaves.length === 0) errors.push('规则不包含任何条件。');
  if (depthOf(root) > 3) {
    errors.push('条件嵌套超过 3 层，请拆分成多条监控任务。');
  }

  for (const leaf of leaves) {
    validateLeaf(leaf, byCode, errors, warnings);

    // 该条件需要的数据能力是否可用
    const need = leafDataNeed(leaf);
    const un = isUnavailable(need.endpoint);
    if (un) {
      warnings.push(
        `条件「${leafSummary(leaf)}」依赖「${un.label}」能力，该能力**暂未开放外部接入**，` +
          `真实数据模式下任务将长期处于降级态。本演示环境使用回放数据，因此仍可评估。`,
      );
    }
  }

  // ── 去重提示：一个只含日历条件的任务每个交易日都会命中 ──
  const kinds = new Set(leaves.map((l) => l.type));
  if (kinds.size === 1 && kinds.has('calendar')) {
    warnings.push('该任务只含日历条件，每个交易日都会命中。已自动按月去重，避免通知淹没。');
  }

  return { errors, warnings };
}

function validateLeaf(
  leaf: Leaf,
  byCode: Map<string, CatalogEntry>,
  errors: string[],
  warnings: string[],
): void {
  const label = leafSummary(leaf);

  if (leaf.type === 'price') {
    const expected = METRIC_UNIT[leaf.metric];
    if (expected && leaf.value.kind === 'const' && leaf.value.unit !== expected) {
      // 允许 CNY 与 PCT 的显式不匹配报错，其余给出提示
      if (
        (expected === 'PCT' && leaf.value.unit !== 'PCT') ||
        (expected === 'CNY' && leaf.value.unit === 'PCT')
      ) {
        errors.push(
          `条件「${label}」的单位不匹配：指标 ${leaf.metric} 期望 ${expected}，实际给了 ${leaf.value.unit}。`,
        );
      }
    }

    // 交叉算子需要历史序列
    if ((leaf.operator === 'cross_above' || leaf.operator === 'cross_below') && !leaf.window) {
      warnings.push(`条件「${label}」使用穿越算子但未指定历史窗口，本版本按当前值比较处理。`);
    }

    // 连续判定必须给次数
    if (leaf.windowOperator === 'consecutive' && !leaf.consecutive) {
      errors.push(`条件「${label}」声明了连续判定，但未给出连续天数。`);
    }
    if (leaf.consecutive && leaf.consecutive > 250) {
      errors.push(`条件「${label}」的连续天数 ${leaf.consecutive} 超出可获取的历史长度。`);
    }

    // 历史窗口上限对齐端点契约（≤10 年）
    if (leaf.window && leaf.window.days > 3650) {
      errors.push(`条件「${label}」的窗口 ${leaf.window.days} 天超过历史接口的 10 年上限。`);
    }

    // 标的类型校验
    const code = subjectCode(leaf.subject);
  const entry = code ? byCode.get(code) : undefined;
    if (entry?.kind === 'index' && INDEX_UNSUPPORTED_METRICS.has(leaf.metric)) {
      errors.push(`指数不支持指标「${leaf.metric}」。`);
    }
  }

  if (leaf.type === 'event') {
    // 事件端点必须能被解析
    const need = leafDataNeed(leaf);
    if (!need.endpoint) {
      errors.push(`条件「${label}」的事件来源无法映射到接口。`);
    }
    if (leaf.filter.minContinueDayCnt !== undefined && leaf.source !== 'limit_up_pool' && leaf.source !== 'limit_up_ladder') {
      warnings.push(`「连板天数」过滤仅对涨停类事件有效，当前事件源为 ${leaf.source}，该过滤可能不生效。`);
    }
  }

  if (leaf.type === 'heat') {
    if (leaf.metric === 'rank_change' && leaf.value.kind === 'const' && leaf.value.value === 0) {
      warnings.push(`条件「${label}」的排名变动阈值为 0，实际上等同于"排名有变化"，可能过于宽松。`);
    }
    if (leaf.source === 'hot_stock_rank_trend' && !leaf.window) {
      warnings.push(`条件「${label}」使用排名走势接口但未指定窗口，本版本按当日榜单处理。`);
    }
  }

  if (leaf.type === 'calendar') {
    if (leaf.predicate === 'days_until_ipo' && !leaf.param?.thscode) {
      warnings.push('新股日历条件未指定标的，需在规则中补充申购标的。');
    }
    if (leaf.predicate === 'nth_trading_day_of_month' && !leaf.param?.nth) {
      errors.push(`条件「${label}」需要指定是本月第几个交易日。`);
    }
  }
}

/** 给用户看的条件简述 */
export function leafSummary(leaf: Leaf): string {
  const opText: Partial<Record<Comparator, string>> = {
    '<': '低于',
    '<=': '不高于',
    '>': '高于',
    '>=': '不低于',
    '==': '等于',
    '!=': '不等于',
    in_top: '进入前',
  };
  switch (leaf.type) {
    case 'price':
      return `${leaf.metric} ${opText[leaf.operator] ?? leaf.operator} ${
        leaf.value.kind === 'const' ? leaf.value.value : '参照值'
      }`;
    case 'event':
      return `${leaf.source} 事件`;
    case 'heat':
      return `热度 ${leaf.metric} ${opText[leaf.operator] ?? leaf.operator} ${
        leaf.value.kind === 'const' ? leaf.value.value : ''
      }`;
    case 'calendar':
      return `日历 ${leaf.predicate}`;
  }
}

function depthOf(c: Condition): number {
  if (c.type === 'and' || c.type === 'or') {
    return 1 + Math.max(0, ...c.children.map(depthOf));
  }
  if (c.type === 'not') return 1 + depthOf(c.child);
  return 1;
}
