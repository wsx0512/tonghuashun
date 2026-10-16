/**
 * 规则求值器 —— 三值逻辑 + 证据构建。
 *
 * 这是把「不得静默生成正常结论」落到代码里的地方。每个叶子返回
 * true / false / unknown，unknown 会在 TaskEvaluation 里向上传播，
 * 最终使任务进入 DEGRADED，而**绝不会**被压成"未触发"。
 *
 * 每个 leaf 的求值结果都附带一份 EvidenceRecord：
 * 来源、端点、参数、request_id、data.timestamp、单位、统计口径、原始响应引用。
 * 用户点开任何一条结论，都能沿这份记录回到原始字段。
 */

import type {
  Condition,
  Leaf,
  ReasonCode,
  Truth,
  Unit,
  Comparator,
} from '../../shared/dsl/types.js';
import { subjectCode } from '../../shared/dsl/types.js';
import type { SourceResult } from '../sources/envelope.js';
import { fmtShanghai, assessFreshness } from '../sources/envelope.js';
import type { FieldComparison } from '../sources/sourceMesh.js';
import { canonicalParams, collectLeaves, isMembershipEndpoint } from './dataNeeds.js';
import { listKeyFor } from '../sources/types.js';
import { effectiveThresholdMs, describeThreshold } from './freshness.js';
import { render } from '../../shared/compliance/templates.js';
import { scan } from '../../shared/compliance/banned.js';

// ────────────────────────── 类型 ──────────────────────────

export interface DataBundleEntry {
  endpoint: string;
  params: Record<string, string>;
  result: SourceResult<any>;
}

/** key = `${endpoint}?${canonicalParams(params)}` */
export type DataBundle = Map<string, DataBundleEntry>;

export interface Observation {
  label: string;
  /** 真实字段名，可回链到原始响应 */
  field: string;
  value: number | string | null;
  unit: Unit | null;
  statisticBasis?: string;
  dataTimestampMs: number | null;
  source: {
    provider: string;
    endpoint: string;
    mode: string;
    requestId: string | null;
    requestParams: Record<string, string>;
    rawResponseRef: string;
  };
}

export interface Claim {
  text: string;
  type: 'fact' | 'inference' | 'unknown';
  citationFields: string[];
}

export interface EvidenceRecord {
  evidenceId: string;
  taskId: string;
  ruleVersionId: string;
  runId: string;
  leafId: string;
  conditionKind: 'price' | 'event' | 'calendar' | 'heat';
  evaluatedAt: number;
  status: 'true' | 'false' | 'unknown';
  observations: Observation[];
  comparison?: { operator: string; lhs: string; rhs: string; unit: string; passed: boolean };
  freshness: { ageMs: number | null; thresholdMs: number; fresh: boolean; note?: string };
  conflicts?: FieldComparison[];
  contributingFactors?: string[];
  claims: Claim[];
  /** 面向用户的中文结论（由白名单模板生成并经合规扫描） */
  narrative: string;
}

export interface LeafEvaluation {
  leafId: string;
  kind: 'price' | 'event' | 'calendar' | 'heat';
  truth: Truth;
  reasonCode: ReasonCode;
  evidence: EvidenceRecord;
}

export interface TaskEvaluation {
  truth: Truth;
  reasonCode: ReasonCode;
  leaves: LeafEvaluation[];
  /** 任务级结论文案 */
  narrative: string;
  degraded: boolean;
  /** 命中的叶子（triggered 时为非空） */
  matchedLeaves: string[];
}

export interface EvaluateArgs {
  root: Condition;
  taskId: string;
  ruleVersionId: string;
  runId: string;
  bundle: DataBundle;
  conflicts: FieldComparison[];
  now: number;
  subjectName: (thscode: string) => string;
}

// ────────────────────────── 主入口 ──────────────────────────

export function evaluateRule(args: EvaluateArgs): TaskEvaluation {
  const leaves = collectLeaves(args.root);
  const results = leaves.map((leaf) => evaluateLeaf(leaf, args));

  // 组合求值：Kleene 三值逻辑
  const truth = combine(args.root, (l) => results.find((r) => r.leafId === l.id)!.truth);

  // 任务级原因码取最严重者
  const reasonCode = pickWorstReason(results);
  const degraded = truth === 'unknown' && reasonCode !== 'OK';

  const matchedLeaves = results.filter((r) => r.truth === true).map((r) => r.leafId);

  return {
    truth,
    reasonCode,
    leaves: results,
    narrative: buildTaskNarrative(args, results, truth, reasonCode),
    degraded,
    matchedLeaves,
  };
}

const SEVERITY: Record<ReasonCode, number> = {
  FAILURE: 9,
  RATE_LIMITED: 8,
  CAPABILITY_DENIED: 7,
  MALFORMED_ENVELOPE: 6,
  UNSUPPORTED: 5,
  NOT_READY: 4,
  STALE: 3,
  EMPTY_DATA: 2,
  CONFLICT: 1,
  OK: 0,
};

function pickWorstReason(results: LeafEvaluation[]): ReasonCode {
  let worst: ReasonCode = 'OK';
  for (const r of results) {
    if (SEVERITY[r.reasonCode] > SEVERITY[worst]) worst = r.reasonCode;
  }
  return worst;
}

/** 递归三值组合 */
function combine(c: Condition, truthOf: (leaf: Leaf) => Truth): Truth {
  switch (c.type) {
    case 'and': {
      let acc: Truth = true;
      for (const ch of c.children) {
        const t = combine(ch, truthOf);
        if (t === false) return false; // 任一为假即可定论
        if (t === 'unknown') acc = 'unknown';
      }
      return acc;
    }
    case 'or': {
      let acc: Truth = false;
      for (const ch of c.children) {
        const t = combine(ch, truthOf);
        if (t === true) return true; // 任一为真即可定论
        if (t === 'unknown') acc = 'unknown';
      }
      return acc;
    }
    case 'not': {
      const t = combine(c.child, truthOf);
      return t === 'unknown' ? 'unknown' : !t;
    }
    default:
      return truthOf(c);
  }
}

// ────────────────────────── 叶子求值 ──────────────────────────

function evaluateLeaf(leaf: Leaf, args: EvaluateArgs): LeafEvaluation {
  const kind = leaf.type;
  const base = {
    evidenceId: `${args.runId}:${leaf.id}`,
    taskId: args.taskId,
    ruleVersionId: args.ruleVersionId,
    runId: args.runId,
    leafId: leaf.id,
    conditionKind: kind,
    evaluatedAt: args.now,
  };

  switch (leaf.type) {
    case 'price':
      return evalPriceLeaf(leaf, base, args);
    case 'event':
      return evalEventLeaf(leaf, base, args);
    case 'heat':
      return evalHeatLeaf(leaf, base, args);
    case 'calendar':
      return evalCalendarLeaf(leaf, base, args);
  }
}

type EvBase = Omit<EvidenceRecord, 'status' | 'observations' | 'freshness' | 'claims' | 'narrative' | 'conditionKind'> & {
  conditionKind: 'price' | 'event' | 'calendar' | 'heat';
};

/** 从 bundle 中找出能提供指定标的的条目（支持单条与批量两种形态） */
function findEntry(
  bundle: DataBundle,
  endpoint: string,
  thscode: string,
): DataBundleEntry | undefined {
  for (const e of bundle.values()) {
    if (e.endpoint !== endpoint) continue;
    const list = (e.params.thscodes ?? e.params.thscode ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0 || list.includes(thscode)) return e;
  }
  return undefined;
}

function mkDegraded(
  base: EvBase,
  branch: 'price' | 'event' | 'heat' | 'calendar',
  reasonCode: ReasonCode,
  detail: string,
  name: string,
  asOf: string | null,
  extraObservations: Observation[] = [],
  extra: Partial<EvidenceRecord> = {},
): LeafEvaluation {
  const narrative = render({
    kind: branch,
    status: 'unknown',
    reasonCode,
    slots: { name, asOf: asOf ?? '未知' },
    degradedDetail: detail,
  });
  guardNarrative(narrative, `${branch}/unknown/${reasonCode}`);

  const evidence: EvidenceRecord = {
    ...base,
    status: 'unknown',
    observations: extraObservations,
    freshness: { ageMs: null, thresholdMs: 0, fresh: false, note: detail },
    claims: [{ text: narrative, type: 'unknown', citationFields: extraObservations.map((o) => o.field) }],
    narrative,
    ...extra,
  };
  return { leafId: base.leafId, kind: base.conditionKind, truth: 'unknown', reasonCode, evidence };
}

/** 合规二次校验：模板产出后仍要过一遍禁用词扫描 */
function guardNarrative(text: string, context: string): void {
  const v = scan(text);
  if (v.length > 0) {
    throw new Error(
      `[合规拦截] ${context} 生成的文案违规：${v.map((x) => x.label).join('、')} → ${text}`,
    );
  }
}

function makeObservation(
  label: string,
  field: string,
  value: number | string | null,
  unit: Unit | null,
  entry: DataBundleEntry,
  result: SourceResult<any>,
  dataTimestampMs: number | null,
  statisticBasis?: string,
): Observation {
  return {
    label,
    field,
    value,
    unit,
    ...(statisticBasis ? { statisticBasis } : {}),
    dataTimestampMs,
    source: {
      provider: entry.result.ok ? 'fuyao(replay)' : 'fuyao(replay)',
      endpoint: entry.endpoint,
      mode: 'replay',
      requestId: result.requestId,
      requestParams: entry.params,
      rawResponseRef: result.raw.id,
    },
  };
}

// ── 价格 ──

// 量比不在此列：它不在快照契约里，须由历史 K 线派生（见 computeHistorical）
const SNAPSHOT_SET = new Set([
  'last_price', 'price_change', 'price_change_ratio_pct', 'open_price', 'high_price',
  'low_price', 'prev_price', 'volume', 'turnover',
]);

function metricUnit(metric: string): Unit {
  if (metric.endsWith('_pct')) return 'PCT';
  if (metric === 'volume') return 'SHARES';
  if (metric === 'turnover') return 'CNY_AMOUNT';
  if (metric === 'volume_ratio') return 'RATIO';
  return 'CNY';
}

const METRIC_LABEL: Record<string, string> = {
  last_price: '最新价',
  close_price: '收盘价',
  price_change: '涨跌额',
  price_change_ratio_pct: '涨跌幅',
  open_price: '开盘价',
  high_price: '最高价',
  low_price: '最低价',
  prev_price: '昨收价',
  volume: '成交量',
  turnover: '成交额',
  volume_ratio: '量比',
  return_pct_window: '区间累计涨跌幅',
  drawdown_from_high_pct: '区间最大回撤',
};

/**
 * 事件 / 热度 / 日历类叶子的时效。
 *
 * 这些叶子走的是**清单成员资格**语义（今天有没有涨停、有没有上榜），
 * 因此**不因数据时点旧而降级** —— 这是刻意设计，见 README 已知边界。
 *
 * 但证据里的时效数字**必须是真的**。早先这里写死 `ageMs: 0, fresh: true`，
 * 等于宣称"数据是 0 分钟前的"，而实际上根本没测过。
 * 一个编造的时效数字比没有更糟：它看起来像一条可核对的事实。
 * 所以这里就地测量，并把"为什么不因此降级"写进 note，避免读者把它当成矛盾。
 */
function listFreshness(
  res: { dataTimestampMs?: number | null },
  endpoint: string,
  now: number,
  kind: '事件' | '热度' | '日历',
): { ageMs: number | null; thresholdMs: number; fresh: boolean; note?: string } {
  const thresholdMs = effectiveThresholdMs(endpoint, now);
  const a = assessFreshness(res.dataTimestampMs ?? null, thresholdMs, now);
  return {
    ageMs: a.ageMs,
    thresholdMs,
    fresh: a.fresh,
    note: `${kind}类条件按清单成员资格判定，不因数据时点旧而降级${a.note ? `（${a.note}）` : ''}`,
  };
}

function evalPriceLeaf(
  leaf: Extract<Leaf, { type: 'price' }>,
  base: EvBase,
  args: EvaluateArgs,
): LeafEvaluation {
  const thscode = subjectCode(leaf.subject);
  const name = args.subjectName(thscode) || thscode;
  const isSnapshot = SNAPSHOT_SET.has(leaf.metric);
  const endpoint = isSnapshot
    ? '/api/a-share/prices/snapshot'
    : '/api/a-share/prices/historical';

  const entry = findEntry(args.bundle, endpoint, thscode);
  if (!entry) {
    return mkDegraded(base, 'price', 'EMPTY_DATA', `未请求到 ${endpoint} 的数据`, name, null);
  }
  if (!entry.result.ok) {
    const err = entry.result;
    return mkDegraded(base, 'price', err.reasonCode, `${err.message}（${err.raw.endpoint}）`, name, null);
  }

  const res = entry.result;
  const data = res.data as any;
  const bars: any[] = data?.item ?? [];

  // 快照端点的 item 带 thscode；历史端点按契约**只服务单只标的**，
  // thscode 在 data 层，item 上不带 —— 所以两种形态要分别处理。
  const item = isSnapshot ? bars.find((i: any) => i?.thscode === thscode) : bars[0];

  if (!item) {
    // 取值类端点：查不到标的 = 拿不到数据 = unknown，**绝不是 false**
    return mkDegraded(
      base,
      'price',
      'EMPTY_DATA',
      `响应中不含 ${thscode} 的数据`,
      name,
      fmtShanghai(res.dataTimestampMs),
    );
  }

  // 计算指标值
  let value: number | null = null;
  let basis = '当日快照';
  if (isSnapshot) {
    const raw = item[leaf.metric];
    value = typeof raw === 'number' ? raw : null;
  } else {
    const computed = computeHistorical(bars, leaf);
    value = computed.value;
    basis = computed.basis;
  }

  if (value === null || !Number.isFinite(value)) {
    return mkDegraded(
      base,
      'price',
      'EMPTY_DATA',
      `字段 ${leaf.metric} 缺失或为空（未补零）`,
      name,
      fmtShanghai(res.dataTimestampMs),
    );
  }

  // 新鲜度
  const threshold = effectiveThresholdMs(endpoint, args.now);
  const ageMs = res.dataTimestampMs === null ? null : args.now - res.dataTimestampMs;
  const fresh = ageMs !== null && ageMs <= threshold;

  const obs = makeObservation(
    METRIC_LABEL[leaf.metric] ?? leaf.metric,
    leaf.metric,
    value,
    metricUnit(leaf.metric),
    entry,
    res,
    res.dataTimestampMs,
    basis,
  );

  if (!fresh) {
    return mkDegraded(
      base,
      'price',
      'STALE',
      `数据时点距今 ${Math.round((ageMs ?? 0) / 60000)} 分钟，超过阈值 ${describeThreshold(threshold)}`,
      name,
      fmtShanghai(res.dataTimestampMs),
      [obs],
      {
        freshness: {
          ageMs,
          thresholdMs: threshold,
          fresh: false,
          note: `超过阈值 ${describeThreshold(threshold)}`,
        },
      },
    );
  }

  // 冲突检查
  const related = args.conflicts.filter((c) => c.thscode === thscode && c.field === leaf.metric);

  /**
   * 两个数据源对同一字段给出不一致的取值时，**不得给出肯定结论**。
   *
   * 依据：题目统一规则「数据缺失、冲突、过期或调用失败时不得静默生成'正常'结论」。
   * 若在主备源吵架的情况下仍判「条件未满足」，那是对用户的一个肯定断言，
   * 而这个断言建立在一个有争议的数字上。
   *
   * 因此冲突 → 该条件判为 unknown（无法判定），任务进 DEGRADED。
   * 两个取值都会列在证据里，用户自己判断。
   */
  if (related.length > 0) {
    const c = related[0]!;
    return mkDegraded(
      base,
      'price',
      'CONFLICT',
      `数据源冲突：${c.sourceA}=${c.valueA} 与 ${c.sourceB}=${c.valueB} 相差 ${(c.deltaPct * 100).toFixed(2)}%，超过容忍度`,
      name,
      fmtShanghai(res.dataTimestampMs),
      [obs],
      { conflicts: related },
    );
  }

  const thresholdValue = leaf.value.kind === 'const' ? leaf.value.value : null;
  const passed = thresholdValue === null ? false : compare(value, leaf.operator, thresholdValue);

  const asOf = fmtShanghai(res.dataTimestampMs);
  const narrative = render({
    kind: 'price',
    status: passed ? 'true' : 'false',
    operator: leaf.operator,
    slots: {
      name,
      value,
      unit: metricUnit(leaf.metric),
      threshold: thresholdValue,
      thresholdUnit: leaf.value.kind === 'const' ? leaf.value.unit : metricUnit(leaf.metric),
      asOf,
      basis,
    },
  });
  guardNarrative(narrative, `price/${leaf.metric}`);

  const evidence: EvidenceRecord = {
    ...base,
    status: passed ? 'true' : 'false',
    observations: [obs],
    comparison: {
      operator: leaf.operator,
      lhs: `${leaf.metric}=${value}`,
      rhs: String(thresholdValue),
      unit: metricUnit(leaf.metric),
      passed,
    },
    freshness: { ageMs, thresholdMs: threshold, fresh: true },
    claims: [
      {
        text: narrative,
        type: 'fact',
        citationFields: [leaf.metric],
      },
    ],
    narrative,
  };

  return {
    leafId: leaf.id,
    kind: 'price',
    truth: passed,
    reasonCode: 'OK',
    evidence,
  };
}

function computeHistorical(
  bars: any[],
  leaf: Extract<Leaf, { type: 'price' }>,
): { value: number | null; basis: string } {
  if (bars.length === 0) return { value: null, basis: '无历史数据' };
  const sorted = [...bars].sort((a, b) => (a.date_ms ?? 0) - (b.date_ms ?? 0));
  const last = sorted[sorted.length - 1];

  switch (leaf.metric) {
    case 'close_price':
      return { value: typeof last.close_price === 'number' ? last.close_price : null, basis: '最近交易日收盘价' };

    case 'return_pct_window': {
      const n = Math.min(leaf.window?.days ?? 20, sorted.length);
      const from = sorted[sorted.length - n];
      if (!from || typeof from.close_price !== 'number' || typeof last.close_price !== 'number') {
        return { value: null, basis: '区间数据不足' };
      }
      const pct = ((last.close_price - from.close_price) / from.close_price) * 100;
      return { value: Number(pct.toFixed(4)), basis: `最近 ${n} 个交易日累计涨跌幅` };
    }

    case 'drawdown_from_high_pct': {
      const n = Math.min(leaf.window?.days ?? 60, sorted.length);
      const slice = sorted.slice(sorted.length - n);
      const highs = slice.map((b) => b.high_price ?? b.close_price).filter((x) => typeof x === 'number');
      if (highs.length === 0 || typeof last.close_price !== 'number') {
        return { value: null, basis: '区间数据不足' };
      }
      const hi = Math.max(...highs);
      const dd = ((hi - last.close_price) / hi) * 100;
      return { value: Number(dd.toFixed(4)), basis: `距最近 ${n} 个交易日最高价的回撤` };
    }

    case 'volume_ratio': {
      /**
       * 量比 = 当日成交量 ÷ 近 N 个交易日的平均成交量。
       *
       * 为什么走历史 K 线而不是读快照字段：扶摇快照契约（`PriceSnapshotItem`）
       * **没有**量比字段（全文档只有另一个端点的 `auction_volume_ratio`）。
       * 早先把它当快照字段直读，于是任何量比条件都取不到值、恒判 unknown +
       * EMPTY_DATA —— 功能等于没做，而且因为降级正确，看起来还挺"诚实"。
       */
      const n = Math.min(leaf.window?.days ?? 5, Math.max(sorted.length - 1, 0));
      if (n <= 0 || typeof last.volume !== 'number') {
        return { value: null, basis: '区间数据不足' };
      }
      const prior = sorted.slice(sorted.length - 1 - n, sorted.length - 1);
      const vols = prior.map((b) => b.volume).filter((x: unknown) => typeof x === 'number');
      if (vols.length === 0) return { value: null, basis: '区间数据不足' };
      const avg = vols.reduce((a: number, b: number) => a + b, 0) / vols.length;
      if (avg === 0) return { value: null, basis: '区间数据不足' };
      return {
        value: Number((last.volume / avg).toFixed(4)),
        basis: `当日成交量 ÷ 近 ${vols.length} 个交易日平均成交量`,
      };
    }

    default:
      return { value: null, basis: '不支持的指标' };
  }
}

// ── 事件 ──

const EVENT_ENDPOINT_MAP: Record<string, string> = {
  anomaly_analysis_list: '/api/a-share/special-data/anomaly-analysis-list',
  anomaly_analysis_stock: '/api/a-share/special-data/anomaly-analysis-stock',
  abnormal_monitor_list: '/api/a-share/special-data/abnormal-monitor-list',
  dragon_tiger_list: '/api/a-share/special-data/dragon-tiger-list',
  limit_up_pool: '/api/a-share/special-data/limit-up-pool',
  limit_down_pool: '/api/a-share/special-data/limit-down-pool',
  limit_break_pool: '/api/a-share/special-data/limit-break-pool',
  limit_up_ladder: '/api/a-share/special-data/limit-up-ladder',
  news_events_search: '/api/news/events/search',
};

const EVENT_LABEL: Record<string, string> = {
  limit_up_pool: '涨停',
  limit_down_pool: '跌停',
  limit_break_pool: '炸板',
  limit_up_ladder: '连板',
  dragon_tiger_list: '登上龙虎榜',
  anomaly_analysis_list: '异动',
  anomaly_analysis_stock: '异动',
  abnormal_monitor_list: '被列入监控',
  news_events_search: '资讯事件',
};

function evalEventLeaf(
  leaf: Extract<Leaf, { type: 'event' }>,
  base: EvBase,
  args: EvaluateArgs,
): LeafEvaluation {
  const thscode = subjectCode(leaf.subject);
  const name = args.subjectName(thscode) || thscode;
  const endpoint = EVENT_ENDPOINT_MAP[leaf.source] ?? '';
  const eventLabel = EVENT_LABEL[leaf.source] ?? '事件';

  const entry = findEntry(args.bundle, endpoint, thscode);
  if (!entry) return mkDegraded(base, 'event', 'EMPTY_DATA', `未请求到 ${endpoint}`, name, null);
  if (!entry.result.ok) {
    const err = entry.result;
    return mkDegraded(base, 'event', err.reasonCode, err.message, name, null);
  }

  const res = entry.result;
  // 列表键随端点而异：龙虎榜是 stock_items，其余是 item（见 types.ts listKeyFor）
  const items: any[] = (res.data as any)?.[listKeyFor(endpoint)] ?? [];
  let hit = items.find((i: any) => i?.thscode === thscode);

  // 附加过滤
  if (hit && leaf.filter.minContinueDayCnt !== undefined) {
    const cnt = hit.continue_day_cnt;
    if (typeof cnt !== 'number' || cnt < leaf.filter.minContinueDayCnt) hit = undefined;
  }
  // 标签过滤**不在这里做**：契约的响应记录没有标签代码字段，过滤由服务端按请求参数
  // `tag_codes` 完成（见 dataNeeds.ts）。若在此比对 `tag_name` 展示名，等于拿代码去比
  // 中文名，永远不命中 —— 那正是早先的 bug。
  if (hit && leaf.filter.monitorLabel) {
    if (hit.monitor_label !== leaf.filter.monitorLabel) hit = undefined;
  }
  if (hit && leaf.filter.netValueGte !== undefined) {
    // 契约的龙虎榜净买入金额字段是 net_value
    const net = hit.net_value;
    if (typeof net !== 'number' || net < leaf.filter.netValueGte) hit = undefined;
  }

  const appears = Boolean(hit);
  const passed = leaf.presence === 'appears' ? appears : !appears;

  const obs = makeObservation(
    eventLabel,
    'thscode',
    appears ? thscode : null,
    null,
    entry,
    res,
    res.dataTimestampMs,
    appears ? `命中 ${eventLabel}` : `未命中 ${eventLabel}`,
  );

  const asOf = fmtShanghai(res.dataTimestampMs);
  const narrative = render({
    kind: 'event',
    status: passed ? 'true' : 'false',
    slots: { name, asOf, date: asOf.slice(0, 10), eventText: eventLabel },
  });
  guardNarrative(narrative, `event/${leaf.source}`);

  return {
    leafId: leaf.id,
    kind: 'event',
    truth: passed,
    reasonCode: 'OK',
    evidence: {
      ...base,
      status: passed ? 'true' : 'false',
      observations: [obs],
      freshness: listFreshness(res, endpoint, args.now, '事件'),
      claims: [{ text: narrative, type: 'fact', citationFields: ['thscode'] }],
      narrative,
    },
  };
}

// ── 热度 ──

function evalHeatLeaf(
  leaf: Extract<Leaf, { type: 'heat' }>,
  base: EvBase,
  args: EvaluateArgs,
): LeafEvaluation {
  const thscode = subjectCode(leaf.subject);
  const name = args.subjectName(thscode) || thscode;
  const endpoint =
    leaf.source === 'hot_stock_rank_trend'
      ? '/api/a-share/special-data/hot-stock-rank-trend'
      : '/api/a-share/special-data/hot-stock-list';

  const entry = findEntry(args.bundle, endpoint, thscode);
  if (!entry) return mkDegraded(base, 'heat', 'EMPTY_DATA', `未请求到 ${endpoint}`, name, null);
  if (!entry.result.ok) {
    const err = entry.result;
    return mkDegraded(base, 'heat', err.reasonCode, err.message, name, null);
  }

  const res = entry.result;
  const items: any[] = (res.data as any)?.item ?? [];
  const item = items.find((i: any) => i?.thscode === thscode);

  // 热榜是**排名榜**：不在榜上是一个明确的业务事实（未进入榜单）
  if (!item) {
    const rankValue = 9999;
    const thresholdValue = leaf.value.kind === 'const' ? leaf.value.value : null;
    const passed = thresholdValue === null ? false : compare(rankValue, leaf.operator, thresholdValue);
    const narrative = render({
      kind: 'heat',
      status: 'false',
      operator: leaf.operator,
      slots: { name, value: rankValue, threshold: thresholdValue, asOf: fmtShanghai(res.dataTimestampMs) },
    });
    guardNarrative(narrative, 'heat/not-listed');
    return {
      leafId: leaf.id,
      kind: 'heat',
      truth: false,
      reasonCode: 'OK',
      evidence: {
        ...base,
        status: 'false',
        observations: [
          makeObservation('热度排名', 'rank', null, 'RANK', entry, res, res.dataTimestampMs, '未进入当日热榜'),
        ],
        freshness: listFreshness(res, endpoint, args.now, '热度'),
        claims: [{ text: narrative, type: 'fact', citationFields: ['rank'] }],
        narrative,
      },
    };
  }

  let value: number | null = null;
  let field = 'rank';
  if (leaf.metric === 'rank' || leaf.metric === 'in_top_n') {
    value = typeof item.rank === 'number' ? item.rank : null;
    field = 'rank';
  } else if (leaf.metric === 'rank_change') {
    value = typeof item.rank_change === 'number' ? item.rank_change : null;
    field = 'rank_change';
  } else {
    // heat 在扶摇契约里是**字符串**，这里显式转换为数值并注明
    value = item.heat != null ? Number(item.heat) : null;
    field = 'heat';
  }

  if (value === null || !Number.isFinite(value)) {
    return mkDegraded(base, 'heat', 'EMPTY_DATA', `字段 ${field} 缺失`, name, fmtShanghai(res.dataTimestampMs));
  }

  const thresholdValue = leaf.value.kind === 'const' ? leaf.value.value : null;
  const passed = thresholdValue === null ? false : compare(value, leaf.operator, thresholdValue);
  const asOf = fmtShanghai(res.dataTimestampMs);

  const narrative = render({
    kind: 'heat',
    status: passed ? 'true' : 'false',
    operator: leaf.operator,
    slots: { name, value, threshold: thresholdValue, asOf },
  });
  guardNarrative(narrative, 'heat');

  return {
    leafId: leaf.id,
    kind: 'heat',
    truth: passed,
    reasonCode: 'OK',
    evidence: {
      ...base,
      status: passed ? 'true' : 'false',
      observations: [
        makeObservation('热度排名', field, value, 'RANK', entry, res, res.dataTimestampMs, '当日热榜'),
      ],
      comparison: {
        operator: leaf.operator,
        lhs: `${field}=${value}`,
        rhs: String(thresholdValue),
        unit: 'RANK',
        passed,
      },
      freshness: listFreshness(res, endpoint, args.now, '热度'),
      claims: [{ text: narrative, type: 'fact', citationFields: [field] }],
      narrative,
    },
  };
}

// ── 日历 ──

function evalCalendarLeaf(
  leaf: Extract<Leaf, { type: 'calendar' }>,
  base: EvBase,
  args: EvaluateArgs,
): LeafEvaluation {
  const entry = findEntry(args.bundle, '/api/a-share/calendar/trading-days', '');
  if (!entry) return mkDegraded(base, 'calendar', 'EMPTY_DATA', '未请求交易日历', '日历', null);
  if (!entry.result.ok) {
    const err = entry.result;
    return mkDegraded(base, 'calendar', err.reasonCode, err.message, '日历', null);
  }

  const res = entry.result;
  const days: any[] = (res.data as any)?.item ?? [];
  const shNow = new Date(args.now + 8 * 3600 * 1000);
  const todayStr = `${shNow.getUTCFullYear()}${String(shNow.getUTCMonth() + 1).padStart(2, '0')}${String(
    shNow.getUTCDate(),
  ).padStart(2, '0')}`;

  const isTrading = days.some((d) => d.date === todayStr);

  let passed = false;
  let value: number | null = null;

  switch (leaf.predicate) {
    case 'is_trading_day':
      passed = isTrading;
      break;
    case 'is_not_trading_day':
      passed = !isTrading;
      break;
    case 'nth_trading_day_of_month': {
      const monthPrefix = todayStr.slice(0, 6);
      const monthDays = days.filter((d) => String(d.date).startsWith(monthPrefix)).sort((a, b) => a.date.localeCompare(b.date));
      const idx = monthDays.findIndex((d) => d.date === todayStr);
      value = idx >= 0 ? idx + 1 : null;
      passed = value === (leaf.param?.nth ?? 1);
      break;
    }
    case 'days_until_ipo':
      // fixture 不含 IPO 日历 → 如实降级
      return mkDegraded(
        base,
        'calendar',
        'NOT_READY',
        '新股日历数据未接入',
        '日历',
        fmtShanghai(res.dataTimestampMs),
      );
  }

  const asOf = fmtShanghai(res.dataTimestampMs);
  const narrative = render({
    kind: 'calendar',
    status: passed ? 'true' : 'false',
    predicate: leaf.predicate,
    slots: { name: '日历', asOf, date: `${todayStr.slice(0, 4)}-${todayStr.slice(4, 6)}-${todayStr.slice(6, 8)}`, value },
  });
  guardNarrative(narrative, `calendar/${leaf.predicate}`);

  return {
    leafId: leaf.id,
    kind: 'calendar',
    truth: passed,
    reasonCode: 'OK',
    evidence: {
      ...base,
      status: passed ? 'true' : 'false',
      observations: [
        makeObservation('交易日历', 'date', todayStr, null, entry, res, res.dataTimestampMs, 'A股交易日序列'),
      ],
      freshness: listFreshness(res, '/api/a-share/calendar/trading-days', args.now, '日历'),
      claims: [{ text: narrative, type: 'fact', citationFields: ['date'] }],
      narrative,
    },
  };
}

// ────────────────────────── 比较 ──────────────────────────

export function compare(lhs: number, op: Comparator, rhs: number): boolean {
  switch (op) {
    case '<':
      return lhs < rhs;
    case '<=':
      return lhs <= rhs;
    case '>':
      return lhs > rhs;
    case '>=':
      return lhs >= rhs;
    case '==':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
    // 交叉算子需要历史序列，本版本按当前值比较处理
    case 'cross_above':
      return lhs > rhs;
    case 'cross_below':
      return lhs < rhs;
    case 'in_top':
      return lhs <= rhs;
    case 'between':
      return false; // 由 range 另行处理
    default:
      return false;
  }
}

// ────────────────────────── 任务级文案 ──────────────────────────

function buildTaskNarrative(
  args: EvaluateArgs,
  results: LeafEvaluation[],
  truth: Truth,
  reasonCode: ReasonCode,
): string {
  if (truth === 'unknown') {
    const worst = results.find((r) => r.reasonCode === reasonCode) ?? results[0]!;
    return `本次无法判定：${worst.evidence.narrative}`;
  }
  if (truth === true) {
    const hits = results.filter((r) => r.truth === true);
    return hits.map((h) => h.evidence.narrative).join('\n');
  }
  const miss = results.filter((r) => r.truth === false);
  return miss.length > 0
    ? `条件未满足：${miss.map((m) => m.evidence.narrative).join(' ')}`
    : '条件未满足。';
}
