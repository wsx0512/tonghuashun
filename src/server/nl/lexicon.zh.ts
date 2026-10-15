/**
 * 中文解析词典。
 *
 * 设计取舍：这是一套**确定性**词典+模式匹配，不是模型。
 * 理由不只是"没有 LLM Key"——题目要求规则「可检查、可修改」，
 * 确定性解析器让用户看到的就是系统真正理解的东西；
 * 解析不出来的部分会**如实报告**，而不是猜一个看起来合理的规则。
 *
 * 词典边界即产品边界，README 中向用户明示（promised subset / 明确不支持）。
 */

import type { Comparator, PriceMetric, Unit } from '../../shared/dsl/types.js';

// ────────────────────────── 逻辑连接词 ──────────────────────────

export const OR_WORDS = ['或者', '或是', '或', '任一', '任意一个', '要不然'];
export const AND_WORDS = ['并且', '而且', '同时', '且', '和', '以及'];
export const NOT_WORDS = ['不是', '并非', '没有'];

// ────────────────────────── 比较算子 ──────────────────────────

export interface OperatorHint {
  words: string[];
  operator: Comparator;
  /** 命中时需要翻转比较方向（如「跌超 5%」等价于「涨跌幅 <= -5%」） */
  negateValue?: boolean;
  /** 强制指定指标 */
  metric?: PriceMetric;
  unit?: Unit;
}

export const OPERATOR_HINTS: OperatorHint[] = [
  // 下跌方向 —— 描述的是"跌"，因此作用在涨跌幅上时要取负
  { words: ['跌破', '跌穿', '低于', '小于', '少于', '不到', '不足'], operator: '<', metric: 'last_price', unit: 'CNY' },
  { words: ['跌超', '跌超过', '跌幅超过', '跌幅大于', '下跌超过', '跌破幅度超过'], operator: '<=', metric: 'price_change_ratio_pct', unit: 'PCT', negateValue: true },
  { words: ['回撤超过', '回撤大于', '回撤达到'], operator: '>=', metric: 'drawdown_from_high_pct', unit: 'PCT' },
  // 上涨方向
  { words: ['突破', '涨破', '高于', '大于', '超过', '多于'], operator: '>', metric: 'last_price', unit: 'CNY' },
  { words: ['涨超', '涨超过', '涨幅超过', '涨幅大于', '上涨超过'], operator: '>=', metric: 'price_change_ratio_pct', unit: 'PCT' },
  { words: ['跌幅超过', '跌幅大于'], operator: '<=', metric: 'price_change_ratio_pct', unit: 'PCT', negateValue: true },
  // 成交量
  { words: ['放量', '量比超过', '量比大于'], operator: '>=', metric: 'volume_ratio', unit: 'RATIO' },
  // 均等
  { words: ['等于', '达到'], operator: '==', metric: 'last_price', unit: 'CNY' },
];

// ────────────────────────── 指标关键词 ──────────────────────────

export interface MetricHint {
  words: string[];
  metric: PriceMetric;
  unit: Unit;
}

export const PRICE_METRIC_HINTS: MetricHint[] = [
  { words: ['收盘价', '收盘'], metric: 'close_price', unit: 'CNY' },
  { words: ['最新价', '现价', '股价', '价格', '价位'], metric: 'last_price', unit: 'CNY' },
  { words: ['开盘价', '开盘'], metric: 'open_price', unit: 'CNY' },
  { words: ['最高价', '最高'], metric: 'high_price', unit: 'CNY' },
  { words: ['最低价', '最低'], metric: 'low_price', unit: 'CNY' },
  { words: ['昨收', '前收'], metric: 'prev_price', unit: 'CNY' },
  { words: ['涨跌幅', '涨幅', '跌幅'], metric: 'price_change_ratio_pct', unit: 'PCT' },
  { words: ['涨跌额'], metric: 'price_change', unit: 'CNY' },
  { words: ['成交量'], metric: 'volume', unit: 'SHARES' },
  { words: ['成交额', '成交金额'], metric: 'turnover', unit: 'CNY_AMOUNT' },
  { words: ['量比'], metric: 'volume_ratio', unit: 'RATIO' },
  { words: ['回撤'], metric: 'drawdown_from_high_pct', unit: 'PCT' },
];

// ────────────────────────── 事件关键词 ──────────────────────────

export interface EventHint {
  words: string[];
  /** 目标事件源（取第一个可用者） */
  sources: string[];
  tags?: string[];
  /** 语义化简述，用于 UI 展示与文案生成 */
  label: string;
}

export const EVENT_HINTS: EventHint[] = [
  {
    words: ['涨停', '封板', '涨停板'],
    sources: ['limit_up_pool'],
    label: '涨停',
  },
  {
    words: ['跌停'],
    sources: ['limit_down_pool'],
    label: '跌停',
  },
  {
    words: ['炸板', '开板'],
    sources: ['limit_break_pool'],
    label: '炸板',
  },
  {
    words: ['连板', '连续涨停'],
    sources: ['limit_up_pool', 'limit_up_ladder'],
    label: '连板',
  },
  {
    words: ['龙虎榜', '上榜', '登上龙虎榜'],
    sources: ['dragon_tiger_list'],
    label: '登上龙虎榜',
  },
  {
    words: ['异动', '异动原因', '大幅异动'],
    sources: ['anomaly_analysis_list'],
    label: '出现异动',
  },
  {
    words: ['重点监控', '严重异动', '被监控', '监管关注'],
    sources: ['abnormal_monitor_list'],
    label: '被列入监控',
  },
];

// ────────────────────────── 热度关键词 ──────────────────────────

export const HEAT_WORDS = ['热榜', '热度', '人气榜', '人气', '热度排名'];

// ────────────────────────── 日历关键词 ──────────────────────────

export const CALENDAR_WORDS = ['交易日', '开市', '休市', '非交易日'];
export const IPO_WORDS = ['新股', '申购', '上市', '打新'];

// ────────────────────────── 中文数字 ──────────────────────────

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

/** 解析中文数字，如「一千二百」→ 1200、「二十」→ 20、「十五」→ 15 */
export function parseChineseNumber(s: string): number | null {
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);

  let total = 0;
  let section = 0;
  let current = 0;
  let matched = false;

  for (const ch of s) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]!;
      matched = true;
    } else if (ch in CN_UNITS) {
      const u = CN_UNITS[ch]!;
      if (u >= 10000) {
        section = (section + current) * u;
        total += section;
        section = 0;
        current = 0;
      } else {
        section += (current || 1) * u;
        current = 0;
      }
      matched = true;
    } else if (ch === '点') {
      // 小数部分：简单处理
      continue;
    } else {
      return null;
    }
  }
  if (!matched) return null;
  return total + section + current;
}

// ────────────────────────── 单位 ──────────────────────────

export interface UnitHint {
  words: string[];
  unit: Unit;
  /** 需要乘的系数（如「万元」= 10000 元） */
  scale?: number;
}

export const UNIT_HINTS: UnitHint[] = [
  { words: ['万元'], unit: 'CNY', scale: 10000 },
  { words: ['亿元'], unit: 'CNY', scale: 100000000 },
  { words: ['块钱', '元', '块'], unit: 'CNY' },
  { words: ['个百分点', ' percent', '%', '％'], unit: 'PCT' },
  { words: ['名以内', '名', '位'], unit: 'RANK' },
  { words: ['个交易日', '天', '日'], unit: 'DAY' },
  { words: ['倍'], unit: 'RATIO' },
  { words: ['万股'], unit: 'SHARES', scale: 10000 },
  { words: ['股'], unit: 'SHARES' },
];

// ────────────────────────── 合规：禁止意图 ──────────────────────────

/**
 * 预测 / 建议类意图。命中的输入**直接拒绝**，不产出任何规则。
 *
 * 这是合规的第一道防线（能力层）。题目明令：
 * 不得输出确定性涨跌预测、收益承诺或直接买卖建议。
 * 我们不仅不输出，连"把它变成监控规则"这条路也堵死——
 * 因为「什么时候买入」本质上就不是一个可监控的事实条件。
 */
export const FORBIDDEN_INTENTS: { pattern: RegExp; label: string }[] = [
  { pattern: /(会|将会|要|能)涨(到|多少|吗|么)/, label: '涨跌预测' },
  { pattern: /(会|将会|要|能)跌(到|多少|吗|么)/, label: '涨跌预测' },
  { pattern: /(什么|啥)(时候|点位)(买|卖|买入|卖出|上车|进场|加仓|减仓)/, label: '买卖时点建议' },
  { pattern: /(能不能|可以|该不该|要不要|是否)(买|卖|买入|卖出|加仓|减仓|抄底|清仓)/, label: '买卖建议' },
  { pattern: /(目标价|止盈位|止损位|上涨空间|翻倍|翻番|稳赚|包赚|必涨|必跌)/, label: '收益承诺或目标价' },
  { pattern: /(推荐|荐股)(一?[只个支]|股票|标的)/, label: '荐股' },
  { pattern: /(能赚|能挣|收益率?(能|会)达到)/, label: '收益承诺' },
  { pattern: /(该|应该|建议)(买|卖|持有|加仓|减仓)/, label: '买卖建议' },
];

// ────────────────────────── 明确不支持的表达 ──────────────────────────

/**
 * 主观 / 模糊表达。这些**不是合规问题，而是能力边界**——
 * 系统无法把它们变成可检查的客观条件，因此如实报告「无法解析」，
 * 而不是猜一个近似规则糊弄过去。
 */
export const SUBJECTIVE_WORDS = [
  '走势健康', '形态好', '趋势不错', '感觉', '看起来', '可能要变盘',
  '有机会', '风险不大', '比较安全', '值得关注', '有潜力', '前景好',
  '重大利好', '重大利空', '消息面',
];
