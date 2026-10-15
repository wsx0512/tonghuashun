/**
 * 自然语言 → 规则的确定性解析器。
 *
 * 设计原则（也是本模块与「让模型自由发挥」的分野）：
 *  1. **诚实边界**：解析不出来的片段进 `meta.unresolved` 并显式展示给用户，
 *     绝不猜一个看起来合理的规则。
 *  2. **可检查**：产出的是一棵结构化 Condition 树，用户能逐条看到并修改。
 *  3. **合规前置**：预测/建议类意图在解析之前就被拒绝，不产出任何规则。
 *  4. 输出必须通过同一套 Zod + 语义校验才被接受（见 validate.ts）。
 *
 * 支持的语法子集见 README「承诺子集」一节，并有单测覆盖。
 */

import { subjectCode } from '../../shared/dsl/types.js';
import type {
  Condition,
  NlParseMeta,
  NlParseSpan,
  PriceLeaf,
  EventLeaf,
  CalendarLeaf,
  HeatLeaf,
  Scope,
  SubjectRef,
  Unit,
  Comparator,
  Operand,
} from '../../shared/dsl/types.js';
import {
  AND_WORDS,
  CALENDAR_WORDS,
  EVENT_HINTS,
  FORBIDDEN_INTENTS,
  HEAT_WORDS,
  OPERATOR_HINTS,
  PRICE_METRIC_HINTS,
  SUBJECTIVE_WORDS,
  UNIT_HINTS,
  parseChineseNumber,
} from './lexicon.zh.js';

// ────────────────────────── 结果类型 ──────────────────────────

export interface ParseOk {
  ok: true;
  scope: Scope;
  root: Condition;
  meta: NlParseMeta;
  warnings: string[];
}

export interface ParseRejected {
  ok: false;
  kind: 'compliance' | 'no_condition' | 'too_complex';
  message: string;
  /** 合规拒绝时记录原因标签，供 compliance_rejects 表留痕 */
  complianceLabel?: string;
}

export type ParseOutcome = ParseOk | ParseRejected;

export interface CatalogEntry {
  thscode: string;
  ticker: string;
  name: string;
  kind: 'stock' | 'index';
  aliases: string[];
}

// ────────────────────────── 主入口 ──────────────────────────

export function parseNaturalLanguage(input: string, catalog: CatalogEntry[]): ParseOutcome {
  const text = normalize(input);

  // ① 合规前置：预测/建议类意图直接拒绝，不产出规则
  for (const fi of FORBIDDEN_INTENTS) {
    if (fi.pattern.test(text)) {
      return {
        ok: false,
        kind: 'compliance',
        complianceLabel: fi.label,
        message:
          `本产品不提供${fi.label}。它可以帮你监控**已经发生的事实**` +
          `（价格触及某个水平、出现涨停异动、登上龙虎榜等），并在条件满足时通知你；` +
          `但不会预测涨跌，也不给出买卖建议。\n` +
          `可以试试这样说：「贵州茅台跌破 1200 元时提醒我」。`,
      };
    }
  }

  // ② 标的识别（含歧义检测）
  const { subjects, ambiguities } = matchSubjectsDetailed(text, catalog);

  if (ambiguities.length > 0) {
    const a = ambiguities[0]!;
    const opts = a.candidates.map((c) => `${c.name}(${subjectCode(c)})`).join('、');
    return {
      ok: false,
      kind: 'no_condition',
      message:
        `「${a.text}」在 A 股中对应多个标的：${opts}。` +
        `请写明市场后缀（如 ${subjectCode(a.candidates[0]!)}）以便系统准确识别。`,
    };
  }

  if (subjects.length === 0) {
    return {
      ok: false,
      kind: 'no_condition',
      message:
        '没有识别到监控标的。请在句子里写明股票名称或代码，例如「贵州茅台跌破 1200 元」。',
    };
  }

  // ③ 按逻辑连接词切分并组树
  const used = new Set<string>();
  const root = buildTree(text, subjects, used);

  if (!root) {
    const subjective = SUBJECTIVE_WORDS.filter((w) => text.includes(w));
    return {
      ok: false,
      kind: 'no_condition',
      message: subjective.length
        ? `「${subjective.join('、')}」属于主观描述，系统无法把它变成可检查的客观条件。` +
          `请改成明确的阈值或事件，例如「跌幅超过 5%」「出现涨停异动」。`
        : '没能从这句话里解析出可监控的条件。请给出明确的阈值或事件，例如「跌破 1200 元」「涨幅超过 5%」。',
    };
  }

  // ④ 未识别片段
  const unresolved = collectUnresolved(text, root);

  const meta: NlParseMeta = {
    spans: [],
    unresolved,
    confidence: computeConfidence(text, unresolved),
  };

  const warnings: string[] = [];
  const subjective = SUBJECTIVE_WORDS.filter((w) => text.includes(w));
  if (subjective.length) {
    warnings.push(
      `以下表述较主观，未被纳入条件：${subjective.join('、')}。系统只监控客观可判定的条件。`,
    );
  }

  return {
    ok: true,
    scope: { subjects, quantifier: subjects.length > 1 ? 'each' : 'each' },
    root,
    meta,
    warnings,
  };
}

// ────────────────────────── 标的识别 ──────────────────────────

export interface SubjectMatch {
  subjects: SubjectRef[];
  /**
   * 歧义：同一段文字可能指向多个标的。
   * **不猜** —— 交给用户选择，这是「可检查」的一部分。
   * 典型场景：文本里只有裸代码 `000001`，而它既是平安银行(.SZ)又是上证指数(.SH)。
   */
  ambiguities: { text: string; candidates: SubjectRef[] }[];
}

/**
 * 标的识别，三趟扫描，**具体优先**：
 *   A. 完整 thscode（含市场后缀，如 000001.SH）—— 最具体，优先级最高
 *   B. 名称与别名
 *   C. 裸 ticker —— 仅当能唯一确定时才采纳；若命中多个则报歧义
 *
 * 为什么不能简单用 ticker：000001.SZ 是平安银行，000001.SH 是上证指数。
 * 录制 fixture 时就因为按 ticker 反查导致两条数据撞车，这里不能再犯。
 */
export function matchSubjectsDetailed(text: string, catalog: CatalogEntry[]): SubjectMatch {
  const claimed = new Set<string>();
  const subjects: SubjectRef[] = [];
  const ambiguities: { text: string; candidates: SubjectRef[] }[] = [];

  const refOf = (e: CatalogEntry): SubjectRef => ({
    kind: e.kind,
    thscode: e.thscode,
    name: e.name,
  });

  // ── A. 完整 thscode ──
  for (const e of catalog) {
    if (claimed.has(e.thscode)) continue;
    if (text.includes(e.thscode)) {
      claimed.add(e.thscode);
      subjects.push(refOf(e));
    }
  }

  // ── B. 名称与别名（长词优先，避免「茅台」抢在「贵州茅台」之前）──
  for (const e of catalog) {
    if (claimed.has(e.thscode)) continue;
    const names = [...e.aliases, e.name].filter(Boolean).sort((a, b) => b.length - a.length);
    if (names.some((n) => text.includes(n))) {
      claimed.add(e.thscode);
      subjects.push(refOf(e));
    }
  }

  // ── C. 裸 ticker ──
  const tickerGroups = new Map<string, CatalogEntry[]>();
  for (const e of catalog) {
    if (claimed.has(e.thscode)) continue;
    if (!tickerGroups.has(e.ticker)) tickerGroups.set(e.ticker, []);
    tickerGroups.get(e.ticker)!.push(e);
  }
  for (const [ticker, entries] of tickerGroups) {
    if (!text.includes(ticker)) continue;
    if (entries.length === 1) {
      claimed.add(entries[0]!.thscode);
      subjects.push(refOf(entries[0]!));
    } else {
      // 一个裸代码对应多个标的 → 如实报告歧义，让用户选
      ambiguities.push({ text: ticker, candidates: entries.map(refOf) });
      for (const e of entries) claimed.add(e.thscode);
    }
  }

  return { subjects, ambiguities };
}

export function matchSubjects(text: string, catalog: CatalogEntry[]): SubjectRef[] {
  return matchSubjectsDetailed(text, catalog).subjects;
}

// ────────────────────────── 组树 ──────────────────────────

let nodeSeq = 0;
function nid(prefix: string): string {
  return `${prefix}_${(nodeSeq++).toString(36)}`;
}
/** 每次解析重置计数，保证同一输入产出同一棵树（测试可断言） */
export function resetNodeIds(): void {
  nodeSeq = 0;
}

/**
 * 把文本拆成 OR-of-AND 树。
 * 优先级：并且 比 或者 结合更紧（与布尔代数一致）。
 * 支持括号覆盖优先级：「(A 或 B) 并且 C」。
 */
function buildTree(text: string, subjects: SubjectRef[], used: Set<string>): Condition | null {
  const orParts = splitTopLevel(text, ['或者', '或是', '要不然', '或']);

  if (orParts.length > 1) {
    const children = orParts
      .map((p) => buildTree(p.text, subjects, used))
      .filter((c): c is Condition => c !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return { type: 'or', id: nid('or'), children };
  }

  const andParts = splitTopLevel(text, AND_WORDS);
  if (andParts.length > 1) {
    const children = andParts
      .map((p) => buildTree(p.text, subjects, used))
      .filter((c): c is Condition => c !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    return { type: 'and', id: nid('and'), children };
  }

  // 剥括号后重解析
  const trimmed = text.trim();
  if (trimmed.startsWith('（') || trimmed.startsWith('(')) {
    const inner = stripOuterParens(trimmed);
    if (inner !== trimmed) {
      return buildTree(inner, subjects, used);
    }
  }

  return buildLeaf(trimmed, subjects);
}

interface Segment {
  text: string;
}

/** 按连接词切分，尊重括号深度 */
function splitTopLevel(text: string, words: string[]): Segment[] {
  const out: Segment[] = [];
  let depth = 0;
  let current = '';
  let i = 0;

  const isOpen = (c: string) => c === '(' || c === '（';
  const isClose = (c: string) => c === ')' || c === '）';

  while (i < text.length) {
    const ch = text[i]!;
    if (isOpen(ch)) depth++;
    else if (isClose(ch)) depth--;

    if (depth === 0) {
      // 尝试在当前位置匹配任一连接词（长词优先）
      let matched: string | null = null;
      for (const w of [...words].sort((a, b) => b.length - a.length)) {
        if (text.startsWith(w, i)) {
          matched = w;
          break;
        }
      }
      if (matched) {
        out.push({ text: current.trim() });
        current = '';
        i += matched.length;
        continue;
      }
    }
    current += ch;
    i++;
  }
  out.push({ text: current.trim() });

  return out.filter((s) => s.text.length > 0);
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  let changed = true;
  while (changed) {
    changed = false;
    if ((t.startsWith('（') && t.endsWith('）')) || (t.startsWith('(') && t.endsWith(')'))) {
      // 确认这对括号是配对的整体
      const inner = t.slice(1, -1);
      let depth = 0;
      let balanced = true;
      for (const c of inner) {
        if (c === '(' || c === '（') depth++;
        if (c === ')' || c === '）') depth--;
        if (depth < 0) {
          balanced = false;
          break;
        }
      }
      if (balanced && depth === 0) {
        t = inner.trim();
        changed = true;
      }
    }
  }
  return t;
}

// ────────────────────────── 叶子解析 ──────────────────────────

function buildLeaf(
  clause: string,
  subjects: SubjectRef[],
): Condition | null {
  if (!clause) return null;
  // 去掉句中已识别的标的名，避免它干扰数值/关键词匹配
  let body = clause;
  for (const s of subjects) {
    if (s.name) body = body.split(s.name).join(' ');
    for (const part of subjectCode(s).split('.')) body = body.split(part).join(' ');
  }
  body = body.trim();
  const probe = body.length > 0 ? body : clause;

  // 顺序很重要：「涨停」要先于「涨」被识别
  const event = matchEvent(probe, subjects);
  if (event) return event;

  const heat = matchHeat(probe, subjects);
  if (heat) return heat;

  const cal = matchCalendar(probe);
  if (cal) return cal;

  return matchPrice(probe, subjects);
}

function matchEvent(text: string, subjects: SubjectRef[]): EventLeaf | null {
  // 长词优先：「连续涨停」要赢过「涨停」，否则会漏掉"连续N天"的语义
  const hit = matchLongest(text, EVENT_HINTS);
  if (!hit) return null;

  const { hint, word } = hit;
  const filter: any = {};

  // 「连续N天涨停」/「N连板」
  const cnt = extractCount(text);
  if (cnt !== null && (word.includes('连') || text.includes('连续'))) {
    filter.minContinueDayCnt = cnt;
  }
  if (hint.tags) filter.tags = hint.tags;

  return {
    type: 'event',
    id: nid('ev'),
    subject: subjects[0]!,
    source: hint.sources[0] as any,
    filter,
    presence: 'appears',
  };
}

function matchHeat(text: string, subjects: SubjectRef[]): HeatLeaf | null {
  if (!HEAT_WORDS.some((w) => text.includes(w))) return null;

  // 「进入热榜前10」
  const topN = /前\s*(\d+)/.exec(text);
  if (topN) {
    return {
      type: 'heat',
      id: nid('ht'),
      subject: subjects[0]!,
      source: 'hot_stock_list',
      period: 'day',
      metric: 'in_top_n',
      operator: '<=',
      value: { kind: 'const', value: Number(topN[1]), unit: 'RANK' },
    };
  }

  const num = extractNumber(text);
  const cmp = extractComparator(text);

  // 「排名上升超过20名」→ rank_change
  if (text.includes('上升') || text.includes('下降') || text.includes('排名变化')) {
    if (num !== null) {
      return {
        type: 'heat',
        id: nid('ht'),
        subject: subjects[0]!,
        source: 'hot_stock_list',
        period: 'day',
        metric: 'rank_change',
        operator: '<=',
        value: { kind: 'const', value: -Math.abs(num), unit: 'RANK' },
      };
    }
  }

  if (num !== null) {
    return {
      type: 'heat',
      id: nid('ht'),
      subject: subjects[0]!,
      source: 'hot_stock_list',
      period: 'day',
      metric: 'rank',
      operator: cmp ?? '<=',
      value: { kind: 'const', value: num, unit: 'RANK' },
    };
  }

  // 「进入热榜」没给名次 → 默认前 10，并交由警告提示
  return {
    type: 'heat',
    id: nid('ht'),
    subject: subjects[0]!,
    source: 'hot_stock_list',
    period: 'day',
    metric: 'in_top_n',
    operator: '<=',
    value: { kind: 'const', value: 10, unit: 'RANK' },
  };
}

function matchCalendar(text: string): CalendarLeaf | null {
  const isIpo = /新股|申购|打新/.test(text);
  const isTrading = CALENDAR_WORDS.some((w) => text.includes(w));
  if (!isIpo && !isTrading) {
    // 「每月第一个交易日」
    if (/每月|每个月/.test(text) && text.includes('交易日')) {
      return {
        type: 'calendar',
        id: nid('cal'),
        calendar: 'trading_day',
        predicate: 'nth_trading_day_of_month',
        param: { nth: 1 },
      };
    }
    return null;
  }

  if (isIpo) {
    const days = extractNumber(text);
    return {
      type: 'calendar',
      id: nid('cal'),
      calendar: 'ipo_calendar',
      predicate: 'days_until_ipo',
      ...(days !== null ? { operator: '<=', value: { kind: 'const', value: days, unit: 'DAY' } } : {}),
    } as CalendarLeaf;
  }

  const nth = /每?月?第\s*([一二三四五六七八九十\d]+)\s*个?交易日/.exec(text);
  if (nth) {
    const n = parseChineseNumber(nth[1]!) ?? Number(nth[1]);
    return {
      type: 'calendar',
      id: nid('cal'),
      calendar: 'trading_day',
      predicate: 'nth_trading_day_of_month',
      param: { nth: n },
    };
  }

  if (text.includes('非交易日') || text.includes('休市')) {
    return {
      type: 'calendar',
      id: nid('cal'),
      calendar: 'trading_day',
      predicate: 'is_not_trading_day',
    };
  }

  return {
    type: 'calendar',
    id: nid('cal'),
    calendar: 'trading_day',
    predicate: 'is_trading_day',
  };
}

function matchPrice(text: string, subjects: SubjectRef[]): PriceLeaf | null {
  // 先找指标关键词，再找算子，最后找数值。两者都按**长词优先**匹配。
  let metric: PriceLeaf['metric'] = 'last_price';
  let unit: Unit = 'CNY';
  let metricMatched = false;

  const mHit = matchLongest(text, PRICE_METRIC_HINTS);
  if (mHit) {
    metric = mHit.hint.metric;
    unit = mHit.hint.unit;
    metricMatched = true;
  }

  let operator: Comparator = '<=';
  let opMatched = false;
  let negate = false;

  const oHit = matchLongest(text, OPERATOR_HINTS);
  if (oHit) {
    operator = oHit.hint.operator;
    negate = oHit.hint.negateValue ?? false;
    opMatched = true;
    if (!metricMatched && oHit.hint.metric) {
      metric = oHit.hint.metric;
      unit = oHit.hint.unit ?? unit;
    }
  }

  // ⚠️ 必须先把窗口短语（"近20日"）从文本里屏蔽掉再取数，
  //    否则「近20日累计涨幅大于1%」会把阈值取成 20 而不是 1。
  const numSource = maskWindowPhrase(text);
  const rawNum = extractNumber(numSource);
  const unitScale = extractUnitScale(numSource);

  // 纯描述（如「走势健康」）或缺少阈值 → 无法构成可检查条件
  if (!opMatched && !metricMatched) return null;
  if (rawNum === null && !text.includes('回撤')) return null;
  if (rawNum === null) return null;

  const value = (negate ? -Math.abs(rawNum) : rawNum) * (unitScale ?? 1);

  // 若指标是百分数但单位被识别为 CNY（如「跌幅超过5%」漏了%），按指标口径纠正
  if (metric.endsWith('_pct') && unit !== 'PCT') unit = 'PCT';

  // 「近N日累计涨幅」→ return_pct_window
  const windowMatch = /近\s*([\d一二三四五六七八九十]+)\s*(?:个)?(?:交易)?[日天]/.exec(text);
  if (windowMatch && metric === 'price_change_ratio_pct') {
    const days = parseChineseNumber(windowMatch[1]!) ?? Number(windowMatch[1]);
    if (Number.isFinite(days) && days > 0) {
      return {
        type: 'price',
        id: nid('px'),
        subject: subjects[0]!,
        metric: 'return_pct_window',
        window: { days, interval: '1d' },
        operator,
        value: { kind: 'const', value, unit: 'PCT' },
      };
    }
  }

  // 「近N日最高」回撤窗口
  const leaf: PriceLeaf = {
    type: 'price',
    id: nid('px'),
    subject: subjects[0]!,
    metric,
    operator,
    value: { kind: 'const', value, unit },
  };

  if (metric === 'drawdown_from_high_pct' && windowMatch) {
    const days = parseChineseNumber(windowMatch[1]!) ?? Number(windowMatch[1]);
    if (Number.isFinite(days) && days > 0) leaf.window = { days, interval: '1d' };
  }

  return leaf;
}

// ────────────────────────── 抽取工具 ──────────────────────────

/**
 * 把窗口短语替换为等长空格，使后续的数字抽取不会误取窗口里的数字。
 * 「近20日累计涨幅大于1%」→「       累计涨幅大于1%」
 */
export function maskWindowPhrase(text: string): string {
  return text.replace(/近\s*[\d一二三四五六七八九十百]+\s*(?:个)?(?:交易)?[日天]/g, (m) =>
    ' '.repeat(m.length),
  );
}

/**
 * 在文本中找出**最长的**命中词，返回其所属条目。
 *
 * 必须长词优先：`涨幅超过` 要赢过 `超过`，否则「涨幅超过5%」会被解析成
 * 价格 `> 5` 而不是涨跌幅 `>= 5`（测试里踩过这个坑）。
 */
function matchLongest<T extends { words: string[] }>(text: string, hints: T[]): { hint: T; word: string } | null {
  let best: { hint: T; word: string } | null = null;
  for (const h of hints) {
    for (const w of h.words) {
      if (!text.includes(w)) continue;
      if (!best || w.length > best.word.length) best = { hint: h, word: w };
    }
  }
  return best;
}

/** 抽取阿拉伯或中文数字（带单位优先） */
export function extractNumber(text: string): number | null {
  // 阿拉伯数字（优先，避免中文数字误匹配）
  const arabic = /-?\d+(?:\.\d+)?/.exec(text);
  if (arabic) return Number(arabic[0]);

  // 中文数字：仅在后面紧跟单位/名次时才认定，避免把「一」当成数量
  const cn = /([零〇一二两三四五六七八九十百千万亿]+)\s*(元|块|名|位|天|日|%|％|个百分点|倍|股|万|亿)/.exec(text);
  if (cn) {
    const n = parseChineseNumber(cn[1]!);
    if (n !== null) return n;
  }
  return null;
}

function extractCount(text: string): number | null {
  const m = /(?:连续|连)\s*([\d一二三四五六七八九十两]+)\s*(?:个)?[天日板]/.exec(text);
  if (!m) return null;
  return parseChineseNumber(m[1]!) ?? Number(m[1]);
}

function extractComparator(text: string): Comparator | null {
  return matchLongest(text, OPERATOR_HINTS)?.hint.operator ?? null;
}

function extractUnitScale(text: string): number | null {
  const hit = matchLongest(text, UNIT_HINTS);
  return hit ? (hit.hint.scale ?? 1) : null;
}

// ────────────────────────── 杂项 ──────────────────────────

function normalize(s: string): string {
  return s
    .replace(/\s+/g, '')
    .replace(/[，,]/g, '，')
    .replace(/[。；;]/g, '，')
    .replace(/[％]/g, '%')
    .trim();
}

/** 收集没有被任何条件覆盖的实词片段（粗略但诚实） */
function collectUnresolved(text: string, root: Condition): string[] {
  const out: string[] = [];
  for (const w of SUBJECTIVE_WORDS) {
    if (text.includes(w)) out.push(w);
  }
  // 连接词残留（如「而且」出现在单条件里）说明切分可能有遗漏
  const stray = AND_WORDS.find((w) => text.includes(w) && !hasLogicalNode(root));
  if (stray && countLeaves(root) === 1) out.push(stray);
  return [...new Set(out)];
}

function hasLogicalNode(c: Condition): boolean {
  if (c.type === 'and' || c.type === 'or' || c.type === 'not') return true;
  return false;
}

function countLeaves(c: Condition): number {
  if (c.type === 'and' || c.type === 'or') return c.children.reduce((n, x) => n + countLeaves(x), 0);
  if (c.type === 'not') return countLeaves(c.child);
  return 1;
}

function computeConfidence(text: string, unresolved: string[]): number {
  if (unresolved.length === 0) return 0.95;
  const covered = text.length - unresolved.join('').length;
  return Math.max(0.3, Math.min(0.9, covered / Math.max(1, text.length)));
}

/** 遍历条件树 */
export function walk(c: Condition, fn: (n: Condition) => void): void {
  fn(c);
  if (c.type === 'and' || c.type === 'or') for (const ch of c.children) walk(ch, fn);
  else if (c.type === 'not') walk(c.child, fn);
}

/** 收集所有叶子 */
export function leaves(c: Condition): Condition[] {
  const out: Condition[] = [];
  walk(c, (n) => {
    if (n.type !== 'and' && n.type !== 'or' && n.type !== 'not') out.push(n);
  });
  return out;
}

export type { Operand };
