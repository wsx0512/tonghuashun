/**
 * 规则模型的 Zod schema。
 *
 * 一份 schema 同时承担三件事：
 *  1. 运行时校验（API 入参、NL 解析产物、LLM 输出）
 *  2. TypeScript 类型来源
 *  3. 「可检查」的第一层 —— 全部使用 strict 模式，**拒绝未知字段**，
 *     这样拼错字段名或塞入不支持的算子会立刻失败，而不是被静默忽略。
 *
 * 注意：这里只管**结构**合法性。跨字段的语义规则（算子与单位是否匹配、
 * 标的类型是否支持该指标、窗口是否越界）在 validate.ts 里做。
 */

import { z } from 'zod';

// ────────────────────────────── 基础 ──────────────────────────────

export const UnitSchema = z.enum(['CNY', 'PCT', 'RATIO', 'SHARES', 'CNY_AMOUNT', 'RANK', 'DAY']);

export const ComparatorSchema = z.enum([
  '>',
  '>=',
  '<',
  '<=',
  '==',
  '!=',
  'between',
  'cross_above',
  'cross_below',
  'in_top',
]);

// ────────────────────────────── 标的与作用域 ──────────────────────────────

export const SubjectRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stock'),
    thscode: z.string().min(1),
    name: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('index'),
    thscode: z.string().min(1),
    name: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('watchlist'),
    id: z.string().min(1),
    name: z.string().optional(),
  }),
]);

export const ScopeSchema = z.strictObject({
  subjects: z.array(SubjectRefSchema).min(1),
  quantifier: z.enum(['each', 'any', 'all', 'aggregate']).default('each'),
});

// ────────────────────────────── 操作数 ──────────────────────────────

export const OperandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('const'),
    value: z.number().finite(),
    unit: UnitSchema,
  }),
  z.strictObject({
    kind: z.literal('ref'),
    subject: SubjectRefSchema,
    metric: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('level'),
    metric: z.literal('index_change_pct'),
  }),
]);

// ────────────────────────────── ① 价格 ──────────────────────────────

export const PriceMetricSchema = z.enum([
  // 快照直接可得
  'last_price',
  'price_change',
  'price_change_ratio_pct',
  'open_price',
  'high_price',
  'low_price',
  'prev_price',
  'volume',
  'turnover',
  'change_5min',
  'change_60d',
  'volume_ratio',
  // 需历史 K 线计算
  'close_price',
  'return_pct_window',
  'drawdown_from_high_pct',
]);

export const PriceLeafSchema = z
  .strictObject({
    type: z.literal('price'),
    id: z.string().min(1),
    subject: SubjectRefSchema,
    metric: PriceMetricSchema,
    window: z
      .strictObject({
        days: z.number().int().positive().max(3650), // 上限 10 年，对齐 historical 端点契约
        interval: z.literal('1d'),
      })
      .optional(),
    operator: ComparatorSchema,
    value: OperandSchema,
    range: z.tuple([z.number().finite(), z.number().finite()]).optional(),
    windowOperator: z.enum(['instant', 'consecutive', 'ever']).optional(),
    consecutive: z.number().int().positive().optional(),
    requireFreshMs: z.number().int().positive().optional(),
  })
  .refine((v) => v.operator !== 'between' || v.range !== undefined, {
    message: 'between 算子必须提供 range',
    path: ['range'],
  });

// ────────────────────────────── ② 事件 ──────────────────────────────

export const EventSourceSchema = z.enum([
  'anomaly_analysis_list',
  'anomaly_analysis_stock',
  'abnormal_monitor_list',
  'dragon_tiger_list',
  'limit_up_pool',
  'limit_down_pool',
  'limit_break_pool',
  'limit_up_ladder',
  'news_events_search',
]);

export const AnomalyTagSchema = z.enum([
  'LIMIT_UP',
  'LIMIT_DOWN',
  'SHARP_RISE',
  'SHARP_FALL',
  'RAPID_RALLY',
  'RAPID_DECLINE',
]);

export const EventFilterSchema = z.strictObject({
  tags: z.array(AnomalyTagSchema).optional(),
  boardType: z.enum(['all', 'org', 'hot_money']).optional(),
  monitorLabel: z.string().optional(),
  minContinueDayCnt: z.number().int().min(0).optional(),
  netValueGte: z.number().finite().optional(),
  reasonContains: z.string().optional(),
  keywordAny: z.array(z.string()).optional(),
});

export const EventLeafSchema = z.strictObject({
  type: z.literal('event'),
  id: z.string().min(1),
  subject: SubjectRefSchema,
  source: EventSourceSchema,
  filter: EventFilterSchema,
  presence: z.enum(['appears', 'disappears']),
});

// ────────────────────────────── ③ 日历 ──────────────────────────────

export const CalendarLeafSchema = z.strictObject({
  type: z.literal('calendar'),
  id: z.string().min(1),
  calendar: z.enum(['trading_day', 'ipo_calendar']),
  predicate: z.enum(['is_trading_day', 'is_not_trading_day', 'nth_trading_day_of_month', 'days_until_ipo']),
  param: z
    .strictObject({
      nth: z.number().int().positive().optional(),
      offsetDays: z.number().int().optional(),
      thscode: z.string().optional(),
    })
    .optional(),
  operator: ComparatorSchema.optional(),
  value: OperandSchema.optional(),
});

// ────────────────────────────── ④ 热度 ──────────────────────────────

export const HeatLeafSchema = z.strictObject({
  type: z.literal('heat'),
  id: z.string().min(1),
  subject: SubjectRefSchema,
  source: z.enum(['hot_stock_list', 'hot_stock_list_history', 'hot_stock_rank_trend']),
  period: z.enum(['day', 'hour']).optional(),
  metric: z.enum(['rank', 'rank_change', 'heat', 'in_top_n']),
  window: z.strictObject({ days: z.number().int().positive().max(365) }).optional(),
  operator: ComparatorSchema,
  value: OperandSchema,
});

// ────────────────────────────── ⑤ 逻辑组合（递归）──────────────────────────────

export type ConditionInput =
  | z.infer<typeof PriceLeafSchema>
  | z.infer<typeof EventLeafSchema>
  | z.infer<typeof CalendarLeafSchema>
  | z.infer<typeof HeatLeafSchema>
  | { type: 'and'; id: string; children: ConditionInput[] }
  | { type: 'or'; id: string; children: ConditionInput[] }
  | { type: 'not'; id: string; child: ConditionInput };

export const ConditionSchema: z.ZodType<ConditionInput> = z.lazy(() =>
  z.discriminatedUnion('type', [
    PriceLeafSchema,
    EventLeafSchema,
    CalendarLeafSchema,
    HeatLeafSchema,
    z.strictObject({
      type: z.literal('and'),
      id: z.string().min(1),
      children: z.array(ConditionSchema).min(1),
    }),
    z.strictObject({
      type: z.literal('or'),
      id: z.string().min(1),
      children: z.array(ConditionSchema).min(1),
    }),
    z.strictObject({
      type: z.literal('not'),
      id: z.string().min(1),
      child: ConditionSchema,
    }),
  ]),
);

// ────────────────────────────── 规则与任务 ──────────────────────────────

export const NlParseSpanSchema = z.strictObject({
  text: z.string(),
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  mappedTo: z
    .strictObject({ nodeId: z.string(), role: z.string() })
    .nullable(),
});

export const NlParseMetaSchema = z.strictObject({
  spans: z.array(NlParseSpanSchema),
  unresolved: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export const RuleDocumentSchema = z.strictObject({
  id: z.string().min(1),
  taskId: z.string().min(1),
  schemaVersion: z.string().min(1),
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  author: z.enum(['user', 'nl_parser', 'llm']),
  source: z.strictObject({
    kind: z.enum(['nl', 'manual']),
    rawText: z.string().optional(),
    parseMeta: NlParseMetaSchema.optional(),
  }),
  scope: ScopeSchema,
  root: ConditionSchema,
});

export const ScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('interval'),
    everyMs: z.number().int().min(1000),
    tradingHoursOnly: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('dailyAt'),
    times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1),
    tradingDaysOnly: z.boolean(),
  }),
]);

export const TriggerPolicySchema = z.strictObject({
  triggerMode: z.enum(['edge', 'level']),
  cooldown: z.strictObject({
    kind: z.enum(['trading_day', 'hours', 'ms']),
    value: z.number().int().nonnegative(),
  }),
  notifyOnRecovery: z.boolean(),
  maxConsecutiveFailures: z.number().int().positive(),
});

// ────────────────────────────── 便捷类型导出 ──────────────────────────────

export type PriceLeafInput = z.infer<typeof PriceLeafSchema>;
export type EventLeafInput = z.infer<typeof EventLeafSchema>;
export type CalendarLeafInput = z.infer<typeof CalendarLeafSchema>;
export type HeatLeafInput = z.infer<typeof HeatLeafSchema>;
export type RuleDocumentInput = z.infer<typeof RuleDocumentSchema>;
