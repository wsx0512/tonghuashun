/**
 * 哨兵 Sentinel —— 统一规则模型（DSL）
 *
 * 设计要点：
 *  1. 一套 Condition 联合类型统一 价格 / 事件 / 日历 / 热度 / 组合 五类条件。
 *  2. 叶子节点**不直接调用数据源**，而是声明「数据需求」；由 dataNeeds.ts 解析成
 *     (端点 + 参数)。这既是「可检查性」的基础，也是跨任务批量取数去重的依据。
 *  3. 每个叶子带稳定 id，供 evidence 回链与去重键（dedupKey）锚定。
 */

// ────────────────────────────── 基础 ──────────────────────────────

/** 数值单位。算子与单位必须匹配（见 validate.ts 的语义校验）。 */
export type Unit =
  | 'CNY' // 人民币元（价格、金额）
  | 'PCT' // 百分数，9.994 表示 +9.994%
  | 'RATIO' // 无量纲倍数，如量比 2.5
  | 'SHARES' // 股数
  | 'CNY_AMOUNT' // 成交额（元）
  | 'RANK' // 名次，越小越靠前
  | 'DAY'; // 天数

export type Comparator =
  | '>'
  | '>='
  | '<'
  | '<='
  | '=='
  | '!='
  | 'between'
  | 'cross_above'
  | 'cross_below'
  | 'in_top';

/** 评定档位：条件命中与否。unknown 是三值逻辑的关键，绝不可塌缩为 false。 */
export type Truth = true | false | 'unknown';

// ────────────────────────────── 标的与作用域 ──────────────────────────────

export type SubjectRef =
  | { kind: 'stock'; thscode: string; name?: string }
  | { kind: 'index'; thscode: string; name?: string }
  | { kind: 'watchlist'; id: string; name?: string };

/** 多个标的时的量化方式：each=逐个独立判定 / any=任一 / all=全部 / aggregate=聚合后判定 */
export type Quantifier = 'each' | 'any' | 'all' | 'aggregate';

export interface Scope {
  subjects: SubjectRef[];
  quantifier: Quantifier;
}

/**
 * 取标的的稳定标识。
 *
 * SubjectRef 是联合类型，watchlist 变体没有 thscode——直接写 `s.thscode`
 * 在类型上不安全。这个函数是唯一的取值入口。
 */
export function subjectCode(s: SubjectRef): string {
  return s.kind === 'watchlist' ? s.id : s.thscode;
}

/** 取标的的展示名（可能为空） */
export function subjectName(s: SubjectRef): string | undefined {
  return s.name;
}

// ────────────────────────────── 操作数 ──────────────────────────────

export type Operand =
  | { kind: 'const'; value: number; unit: Unit }
  /** 相对另一个标的的同一指标比较（如个股涨幅 vs 指数涨幅） */
  | { kind: 'ref'; subject: SubjectRef; metric: string }
  | { kind: 'level'; metric: 'index_change_pct' };

// ────────────────────────────── ① 价格 ──────────────────────────────

/** 快照直接可得 */
export type SnapshotMetric =
  | 'last_price'
  | 'price_change'
  | 'price_change_ratio_pct'
  | 'open_price'
  | 'high_price'
  | 'low_price'
  | 'prev_price'
  | 'volume'
  | 'turnover'
  | 'change_5min'
  | 'change_60d'
  | 'volume_ratio';

/** 需要历史 K 线计算的 */
export type HistoricalMetric =
  | 'close_price'
  | 'return_pct_window' // 近 N 交易日累计涨跌幅
  | 'drawdown_from_high_pct'; // 距近 N 日最高价回撤

export type PriceMetric = SnapshotMetric | HistoricalMetric;

export type WindowOperator = 'instant' | 'consecutive' | 'ever';

export interface PriceLeaf {
  type: 'price';
  id: string;
  subject: SubjectRef;
  metric: PriceMetric;
  /** 仅历史类 metric 需要；窗口天数 */
  window?: { days: number; interval: '1d' };
  operator: Comparator;
  value: Operand;
  /** between 时使用 */
  range?: [number, number];
  windowOperator?: WindowOperator;
  /** windowOperator='consecutive' 时必需 */
  consecutive?: number;
  /** 覆盖默认过期阈值（毫秒） */
  requireFreshMs?: number;
}

// ────────────────────────────── ② 事件 ──────────────────────────────

/**
 * 事件来源。
 * 注意：`news_events_search` 在扶摇文档中标注「该能力暂未开放外部接入」，
 * 保留此处是为了让它作为 CAPABILITY_DENIED 降级场景的真实依据。
 */
export type EventSource =
  | 'anomaly_analysis_list'
  | 'anomaly_analysis_stock'
  | 'abnormal_monitor_list'
  | 'dragon_tiger_list'
  | 'limit_up_pool'
  | 'limit_down_pool'
  | 'limit_break_pool'
  | 'limit_up_ladder'
  | 'news_events_search';

/** 异动标签，取自扶摇 anomaly-analysis-list 的 tag_codes */
export type AnomalyTag =
  | 'LIMIT_UP'
  | 'LIMIT_DOWN'
  | 'SHARP_RISE'
  | 'SHARP_FALL'
  | 'RAPID_RALLY'
  | 'RAPID_DECLINE';

export interface EventFilter {
  tags?: AnomalyTag[];
  boardType?: 'all' | 'org' | 'hot_money';
  monitorLabel?: string;
  minContinueDayCnt?: number;
  /** 龙虎榜净买入下限（元） */
  netValueGte?: number;
  /** 涨停原因子串匹配 */
  reasonContains?: string;
  keywordAny?: string[];
}

export interface EventLeaf {
  type: 'event';
  id: string;
  subject: SubjectRef;
  source: EventSource;
  filter: EventFilter;
  presence: 'appears' | 'disappears';
}

// ────────────────────────────── ③ 日历 ──────────────────────────────

export type CalendarKind = 'trading_day' | 'ipo_calendar';

export type CalendarPredicate =
  | 'is_trading_day'
  | 'is_not_trading_day'
  | 'nth_trading_day_of_month'
  | 'days_until_ipo';

export interface CalendarLeaf {
  type: 'calendar';
  id: string;
  calendar: CalendarKind;
  predicate: CalendarPredicate;
  param?: { nth?: number; offsetDays?: number; thscode?: string };
  operator?: Comparator;
  value?: Operand;
}

// ────────────────────────────── ④ 热度 ──────────────────────────────

export type HeatSource = 'hot_stock_list' | 'hot_stock_list_history' | 'hot_stock_rank_trend';

export type HeatMetric = 'rank' | 'rank_change' | 'heat' | 'in_top_n';

export interface HeatLeaf {
  type: 'heat';
  id: string;
  subject: SubjectRef;
  source: HeatSource;
  period?: 'day' | 'hour';
  metric: HeatMetric;
  window?: { days: number };
  operator: Comparator;
  value: Operand;
}

// ────────────────────────────── ⑤ 逻辑组合 ──────────────────────────────

export type LogicalNode =
  | { type: 'and'; id: string; children: Condition[] }
  | { type: 'or'; id: string; children: Condition[] }
  | { type: 'not'; id: string; child: Condition };

export type Leaf = PriceLeaf | EventLeaf | CalendarLeaf | HeatLeaf;
export type Condition = Leaf | LogicalNode;

// ────────────────────────────── 规则与任务 ──────────────────────────────

export interface NlParseSpan {
  text: string;
  from: number;
  to: number;
  /** 该片段被映射到了哪个节点；未识别时为 null */
  mappedTo: { nodeId: string; role: string } | null;
}

export interface NlParseMeta {
  spans: NlParseSpan[];
  /** 未能识别的原文片段——必须显式展示给用户，不猜测 */
  unresolved: string[];
  confidence: number;
}

export interface RuleDocument {
  id: string;
  taskId: string;
  schemaVersion: string;
  /** 单调递增，不可回改 */
  version: number;
  createdAt: number;
  author: 'user' | 'nl_parser' | 'llm';
  source: {
    kind: 'nl' | 'manual';
    rawText?: string;
    parseMeta?: NlParseMeta;
  };
  scope: Scope;
  root: Condition;
}

export type Schedule =
  | { kind: 'interval'; everyMs: number; tradingHoursOnly: boolean }
  | { kind: 'dailyAt'; times: string[]; tradingDaysOnly: boolean };

export interface TriggerPolicy {
  /** edge=条件需从 false 回到 true 才再触发；level=条件为真即可触发 */
  triggerMode: 'edge' | 'level';
  cooldown: { kind: 'trading_day' | 'hours' | 'ms'; value: number };
  notifyOnRecovery: boolean;
  maxConsecutiveFailures: number;
}

export type TaskState =
  | 'DRAFT'
  | 'PENDING'
  | 'EVALUATING'
  | 'TRIGGERED'
  | 'COOLDOWN'
  | 'DEGRADED'
  | 'RECOVERING'
  | 'PAUSED'
  | 'FAILED'
  | 'ARCHIVED';

export interface TaskHealth {
  consecutiveFailures: number;
  lastEvaluatedAt: number | null;
  lastReasonCode: string | null;
  degradedSince: number | null;
}

export interface MonitorTask {
  id: string;
  name: string;
  activeRuleVersionId: string;
  schedule: Schedule;
  policy: TriggerPolicy;
  state: TaskState;
  health: TaskHealth;
  cooldownUntil: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ────────────────────────────── 降级原因 ──────────────────────────────

/**
 * 降级原因码。优先级：FAILURE/RATE_LIMITED > CAPABILITY_DENIED > STALE > CONFLICT > OK
 * 多因命中时取最严重者为主因，其余进 contributingFactors。
 */
export type ReasonCode =
  | 'OK'
  | 'STALE'
  | 'CONFLICT'
  | 'FAILURE'
  | 'RATE_LIMITED'
  | 'CAPABILITY_DENIED'
  | 'NOT_READY'
  | 'UNSUPPORTED'
  | 'MALFORMED_ENVELOPE'
  | 'EMPTY_DATA';

// ────────────────────────────── 数据需求 ──────────────────────────────

/** 叶子解析出的数据需求：一个逻辑端点 + 一份规范化参数 */
export interface DataNeed {
  endpoint: string;
  params: Record<string, string>;
  /** 哪个叶子需要它，便于回填 */
  leafIds: string[];
}
