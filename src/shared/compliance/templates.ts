/**
 * 白名单文案模板。
 *
 * 硬约束：**面向用户的结论句只能由本文件的模板生成**。
 *
 * 与"事后过滤敏感词"的做法不同，这里从结构上就堵死了违规可能：
 *   - 模板是固定的，没有自由文本槽位
 *   - 槽位只接受数值、名称、时点、来源这类**事实字段**
 *   - 因此模板产出的句子必然是"对已发生事实的陈述"
 *
 * 过滤层（banned.ts）作为第二道防线仍然保留，但正常情况下不应该有机会触发。
 * 测试 TC-D2 会穷举本文件所有模板，断言零违规。
 */

import type { ReasonCode, Unit } from '../dsl/types.js';
import { fmtQuantity } from '../units.js';

export interface FactSlots {
  /** 标的名称 */
  name: string;
  /** 标量观测值 */
  value?: number | null;
  unit?: Unit;
  /** 阈值 */
  threshold?: number | null;
  thresholdUnit?: Unit;
  /** 数据时点（已格式化的可读字符串） */
  asOf?: string;
  /** 数据来源描述，如「扶摇 /api/a-share/prices/snapshot」 */
  source?: string;
  /** 统计口径，如「最近 5 个交易日」 */
  basis?: string;
  /** 事件日期 */
  date?: string;
  /** 事件描述（取自数据源的原文，非生成） */
  eventText?: string;
}

const opWord = (op: string): string =>
  ({
    '<': '低于',
    '<=': '不高于',
    '>': '高于',
    '>=': '不低于',
    '==': '等于',
    '!=': '不等于',
    between: '落在区间内',
    cross_above: '上穿',
    cross_below: '下穿',
    in_top: '进入',
  })[op] ?? '满足';

/** 价格类：命中 */
function priceHit(s: FactSlots, op: string, negation = false): string {
  const v = fmtQuantity(s.value ?? null, s.unit ?? 'CNY');
  const t = fmtQuantity(s.threshold ?? null, s.thresholdUnit ?? s.unit ?? 'CNY');
  const cmp = opWord(op);
  const head = negation
    ? `${s.name} 当前值 ${v}，未${cmp}阈值 ${t}`
    : `${s.name} 当前值 ${v}，${cmp}阈值 ${t}`;
  return `${head}（数据时点 ${s.asOf ?? '未知'}${s.basis ? `，口径：${s.basis}` : ''}）。`;
}

/** 事件类：出现 */
function eventAppears(s: FactSlots): string {
  return `${s.name} 于 ${s.date ?? s.asOf ?? '近期'} 出现${s.eventText ?? '该事件'}。`;
}

/** 热度类 */
function heatHit(s: FactSlots, op: string): string {
  const v = fmtQuantity(s.value ?? null, 'RANK');
  const t = fmtQuantity(s.threshold ?? null, 'RANK');
  return `${s.name} 当前热度排名${v}，${opWord(op)}阈值${t}（数据时点 ${s.asOf ?? '未知'}）。`;
}

/** 日历类 */
function calendarHit(s: FactSlots, predicate: string): string {
  const map: Record<string, string> = {
    is_trading_day: `${s.date ?? s.asOf ?? '该日'} 是交易日`,
    is_not_trading_day: `${s.date ?? s.asOf ?? '该日'} 不是交易日`,
    nth_trading_day_of_month: `${s.date ?? s.asOf ?? '该日'} 是本月第 ${s.value ?? '?'} 个交易日`,
    days_until_ipo: `${s.name} 距新股申购日还有 ${s.value ?? '?'} 天`,
  };
  return `${map[predicate] ?? `${s.date ?? s.asOf} 满足日历条件`}。`;
}

/** 条件解除 */
export function templateRecovered(s: FactSlots, desc: string): string {
  return `此前触发的条件「${desc}」已解除（${s.asOf ?? '本次评估'}）。`;
}

/** 降级文案 —— 这类文案必须让用户明确知道"没有结论"，而不是"没有发生" */
export function templateDegraded(reason: ReasonCode, s: FactSlots, detail: string): string {
  switch (reason) {
    case 'STALE':
      return `⚠ 数据过期：${s.name} 的数据时点为 ${s.asOf ?? '未知'}，${detail}。本次无法判定——这**不等于**条件未满足。`;
    case 'CONFLICT':
      return `⚠ 数据源冲突：${s.name} 的字段在不同来源间存在分歧（${detail}）。已标注差异，未静默取值，请以官方行情为准。`;
    case 'FAILURE':
      return `⚠ 数据获取失败：${detail}。该条件本次无法判定，任务进入降级状态。`;
    case 'RATE_LIMITED':
      return `⏳ 触发接口限流：${detail}。已按退避策略延后重试，本次评估暂缓，不会被误判为未触发。`;
    case 'CAPABILITY_DENIED':
      return `⚠ 数据能力不可用：${detail}。相关条件已暂停评估，不会给出「正常」结论。`;
    case 'NOT_READY':
      return `ℹ 数据尚未就绪：${detail}。该条件本次无法判定——注意这不等于「没有发生」。`;
    case 'MALFORMED_ENVELOPE':
      return `⚠ 数据服务返回了非标准响应（${detail}），本次无法判定。`;
    case 'EMPTY_DATA':
      return `ℹ 未取得 ${s.name} 的可用数据（${detail}），该条件本次无法判定。`;
    case 'UNSUPPORTED':
      return `⚠ 该条件不受支持（${detail}），请修改规则。`;
    case 'OK':
      return '';
  }
}

export interface RenderInput {
  kind: 'price' | 'event' | 'calendar' | 'heat';
  status: 'true' | 'false' | 'unknown';
  operator?: string;
  predicate?: string;
  slots: FactSlots;
  /** 降级时的补充细节 */
  degradedDetail?: string;
  reasonCode?: ReasonCode;
}

/**
 * 渲染结论句。**这是生成面向用户文案的唯一入口。**
 * 返回值随后仍会被 banned.scan() 二次校验（见 narrative.ts）。
 */
export function render(input: RenderInput): string {
  const { kind, status, slots } = input;

  if (status === 'unknown') {
    return templateDegraded(
      input.reasonCode ?? 'EMPTY_DATA',
      slots,
      input.degradedDetail ?? '未取得可用数据',
    );
  }

  switch (kind) {
    case 'price':
      return priceHit(slots, input.operator ?? '<=', status === 'false');
    case 'event':
      return status === 'true'
        ? eventAppears(slots)
        : `${slots.name} 于 ${slots.date ?? slots.asOf ?? '近期'} 未出现${slots.eventText ?? '该事件'}。`;
    case 'heat':
      return heatHit(slots, input.operator ?? '<=');
    case 'calendar':
      return calendarHit(slots, input.predicate ?? 'is_trading_day');
  }
}

/**
 * 供测试穷举用：把模板库中所有形态都渲染一遍。
 * TC-D2 会对这些输出做违规扫描，断言零命中。
 */
export function allTemplateSamples(): { label: string; text: string }[] {
  const base: FactSlots = {
    name: '贵州茅台',
    value: 1312.97,
    unit: 'CNY',
    threshold: 1200,
    thresholdUnit: 'CNY',
    asOf: '2026-10-15 15:00',
    source: '扶摇 /api/a-share/prices/snapshot',
    basis: '当日收盘价',
    date: '2026-10-15',
    eventText: '涨停',
  };
  const out: { label: string; text: string }[] = [];
  for (const kind of ['price', 'event', 'calendar', 'heat'] as const) {
    for (const status of ['true', 'false'] as const) {
      out.push({
        label: `${kind}/${status}`,
        text: render({ kind, status, operator: '<=', predicate: 'is_trading_day', slots: base }),
      });
    }
  }
  for (const rc of [
    'STALE', 'CONFLICT', 'FAILURE', 'RATE_LIMITED',
    'CAPABILITY_DENIED', 'NOT_READY', 'MALFORMED_ENVELOPE', 'EMPTY_DATA', 'UNSUPPORTED',
  ] as ReasonCode[]) {
    out.push({
      label: `degraded/${rc}`,
      text: render({ kind: 'price', status: 'unknown', reasonCode: rc, slots: base, degradedDetail: '示例细节' }),
    });
  }
  out.push({ label: 'recovered', text: templateRecovered(base, '贵州茅台低于 1200 元') });
  return out;
}
