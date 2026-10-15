/**
 * 出站数据净化 —— 合规的第二道防线，作用在**数据**而非文案上。
 *
 * 为什么需要它：有些数据源会在数值字段之外**附带文字性判断**。
 * 真实案例（已核实）：东方财富龙虎榜的 EXPLAIN 字段返回
 *      「普通席位买入，成功率44.94%」
 * 这是对历史席位行为的统计外推，属于预测性表述。题目明令：
 * 不得输出确定性涨跌预测、收益承诺或直接买卖建议。
 *
 * 做法不是硬编码字段名，而是**对每个字符串字段做合规扫描**，
 * 命中即丢弃并留痕。这样将来数据源多返回一个 `xxx_advice` 字段也能自动挡住。
 *
 * 对应测试：TC-D5。
 */

import { scan } from '../../shared/compliance/banned.js';

export interface SanitizeResult<T> {
  data: T;
  /** 被丢弃的字段，供审计与测试断言 */
  dropped: { path: string; value: string; reason: string }[];
}

/**
 * 递归净化。对对象中每个字符串值做合规扫描，命中即删除该键。
 * 只删字符串字段——数值字段不受影响，不会破坏数据结构。
 */
export function sanitizeDeep<T>(input: T, basePath = ''): SanitizeResult<T> {
  const dropped: { path: string; value: string; reason: string }[] = [];

  const walk = (node: any, path: string): any => {
    if (Array.isArray(node)) {
      return node.map((v, i) => walk(v, `${path}[${i}]`));
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(node)) {
        const p = path ? `${path}.${k}` : k;
        if (typeof v === 'string') {
          const hits = scan(v);
          if (hits.length > 0) {
            dropped.push({
              path: p,
              value: v,
              reason: hits.map((x) => x.label).join('、'),
            });
            continue; // 丢弃该字段
          }
          out[k] = v;
        } else {
          out[k] = walk(v, p);
        }
      }
      return out;
    }
    return node;
  };

  return { data: walk(input, basePath) as T, dropped };
}
