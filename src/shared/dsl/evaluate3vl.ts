/**
 * Kleene 三值逻辑 —— 「不得静默生成正常结论」的强制实现。
 *
 * 这是本系统最重要的一个文件。题目明确要求：数据缺失、冲突、过期或调用失败时
 * **不得静默生成"正常"结论**。
 *
 * 实现方式：每个叶子条件返回 true | false | 'unknown'，组合运算走 Kleene 三值逻辑，
 * 任务级只要最终结果是 unknown 就进 DEGRADED —— 绝不塌缩为「未触发」。
 *
 * 真值表（T=true, F=false, U=unknown）：
 *
 *   AND | T  F  U        OR  | T  F  U        NOT
 *   ----+---------        ----+---------       ----
 *    T  | T  F  U         T  | T  T  T         T → F
 *    F  | F  F  F         F  | T  F  U         F → T
 *    U  | U  F  U         U  | T  U  U         U → U
 *
 * 直觉：AND 里一个 F 足以定论（即使另一支未知）；OR 里一个 T 足以定论。
 */

import type { Truth } from './types.js';

export const T: Truth = true;
export const F: Truth = false;
export const U: Truth = 'unknown';

/** 三值合取 */
export function and3(a: Truth, b: Truth): Truth {
  if (a === false || b === false) return false; // 任一为假即可定论为假
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return true;
}

/** 三值析取 */
export function or3(a: Truth, b: Truth): Truth {
  if (a === true || b === true) return true; // 任一为真即可定论为真
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return false;
}

/** 三值否定：unknown 取反仍是 unknown */
export function not3(a: Truth): Truth {
  if (a === 'unknown') return 'unknown';
  return !a;
}

/** 多值合取，空集合视为 unknown（无条件的 AND 不应被当作真） */
export function andAll(xs: readonly Truth[]): Truth {
  if (xs.length === 0) return 'unknown';
  return xs.reduce(and3, T);
}

/** 多值析取，空集合视为 unknown */
export function orAll(xs: readonly Truth[]): Truth {
  if (xs.length === 0) return 'unknown';
  return xs.reduce(or3, F);
}

/**
 * 量化多个标的的评定结果。
 * - each: 逐标的独立判定，此处取"全部"作为该任务的整体真值（每个标的各产生自己的通知）
 * - any:  任一为真
 * - all:  全部为真
 * - aggregate: 聚合判定，交由调用方传入已聚合的单一真值（此处退化为 all）
 */
export function quantify(
  quantifier: 'each' | 'any' | 'all' | 'aggregate',
  results: readonly Truth[],
): Truth {
  if (results.length === 0) return 'unknown';
  switch (quantifier) {
    case 'any':
      return orAll(results);
    case 'each':
    case 'all':
    case 'aggregate':
    default:
      return andAll(results);
  }
}

/** 是否已可定论（非 unknown） */
export function isDecided(t: Truth): boolean {
  return t !== 'unknown';
}

/** 把三值映射为给用户看的短标签 */
export function truthLabel(t: Truth): string {
  if (t === true) return '已触发';
  if (t === false) return '未触发';
  return '无法判定';
}
