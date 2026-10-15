/**
 * 合规过滤层。
 *
 * 题目统一规则原文：
 *   「产品不得输出确定性涨跌预测、收益承诺或直接买卖建议；
 *     事实、推断与不确定信息必须区分。」
 *
 * 本模块的作用是**强制**这一点，而不是靠写文案时自觉：
 * 所有面向用户的结论句在出站前都要过一遍 scan()，命中即失败。
 * 测试 TC-D2/TC-D3 会穷举所有模板做扫描。
 *
 * 设计上还有一个更根本的约束在 templates.ts：结论句只能由白名单模板生成，
 * 模板本身不含自由文本槽位——所以"写出一句违规文案"在结构上就很难发生。
 */

/** 禁用词：命中即视为违规 */
export const BANNED_WORDS: string[] = [
  // 预测
  '预计', '预期', '将会', '将要', '有望', '料将', '势必', '即将上涨', '即将下跌',
  '会涨', '会跌', '看涨', '看跌', '后市', '目标价', '上涨空间', '下跌空间',
  // 收益承诺
  '稳赚', '包赚', '必涨', '必跌', '翻倍', '翻番', '保本', '保证收益', '无风险',
  '收益率能', '收益率会', '赚钱机会',
  // 买卖建议
  '建议买入', '建议卖出', '建议加仓', '建议减仓', '建议持有', '建议清仓',
  '推荐买入', '推荐卖出', '推荐股票', '荐股', '值得买入', '值得买', '可以买',
  '可以卖', '应该买', '应该卖', '买入时机', '卖出时机', '进场', '建仓',
  // 绝对化
  '肯定', '一定会', '绝对',
  // 统计胜率/成功率类 —— **这类表述来自真实数据源**：
  // 东方财富龙虎榜的 EXPLAIN 字段会返回「普通席位买入，成功率44.94%」，
  // 这是对历史席位行为的统计外推，属于预测性表述，题目明令不得呈现。
  // 见测试 TC-D5：适配器必须丢弃该字段。
  '成功率', '胜率', '获利概率', '上涨概率', '下跌概率', '盈利概率', '打板成功率',
];

/**
 * 句式规则：即使不含禁用词，某些句式本身就构成预测或建议。
 */
export const BANNED_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /(会|将|将要|即将)[^，。；]{0,6}(涨|跌|上行|下行|突破|回落)/, label: '将来时涨跌表述' },
  { pattern: /建议[^，。；]{0,8}(买|卖|加仓|减仓|持有|清仓)/, label: '买卖建议句式' },
  {
    pattern:
      /(可以|应当|应该|不妨|不如)[^，。；]{0,6}(买|卖|入手|出局|加仓|减仓|建仓|清仓|抄底|止盈|止损)/,
    label: '祈使句买卖建议',
  },
  { pattern: /(上涨|下跌|反弹|回调)[^，。；]{0,4}(概率|可能性|空间)[^，。；]{0,4}[为是有高\d]/, label: '概率化涨跌预测' },
  // 数据源自带的统计外推，如「成功率44.94%」「胜率 62%」
  { pattern: /(成功|胜|盈利|获利|封板|连板)率\s*[:：]?\s*\d/, label: '成功率/胜率类预测性表述' },
  { pattern: /\d+(\.\d+)?\s*%[^，。；]{0,4}(概率|成功率|胜率)/, label: '概率化表述' },
];

export interface Violation {
  kind: 'word' | 'pattern';
  matched: string;
  label: string;
}

/** 扫描一段文案，返回所有违规项 */
export function scan(text: string): Violation[] {
  const out: Violation[] = [];
  for (const w of BANNED_WORDS) {
    if (text.includes(w)) out.push({ kind: 'word', matched: w, label: `禁用词「${w}」` });
  }
  for (const p of BANNED_PATTERNS) {
    const m = p.pattern.exec(text);
    if (m) out.push({ kind: 'pattern', matched: m[0], label: p.label });
  }
  return out;
}

/** 是否合规 */
export function isCompliant(text: string): boolean {
  return scan(text).length === 0;
}

/**
 * 运行期守卫：不合规时替换为中性文案并留痕。
 *
 * 注意这里**必须抛错而不是静默过滤**——静默过滤会掩盖模板本身的缺陷，
 * 让违规文案在测试里查不出来。开发/测试环境下直接抛，让问题暴露。
 */
export class ComplianceViolationError extends Error {
  constructor(
    message: string,
    public readonly violations: Violation[],
    public readonly original: string,
  ) {
    super(message);
    this.name = 'ComplianceViolationError';
  }
}

export function assertCompliant(text: string, context: string): void {
  const v = scan(text);
  if (v.length > 0) {
    throw new ComplianceViolationError(
      `[合规拦截] ${context} 生成的文案命中 ${v.length} 项违规：${v.map((x) => x.label).join('、')}\n` +
        `原文：${text}`,
      v,
      text,
    );
  }
}

/** 中性兜底文案：当某条文案被拦下时用它替换，保证用户仍能看到"发生了什么" */
export function neutralFallback(reason: string): string {
  return `该条件本次未能生成合规描述（${reason}），请查看下方证据明细了解原始数据。`;
}
