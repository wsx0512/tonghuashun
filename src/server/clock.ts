/**
 * 可注入时钟。
 *
 * 为什么需要它：
 *  1. 调度器、冷却、去重、过期判定都依赖"现在几点"，测试里必须能拨快表盘，
 *     否则 B 组用例（冷却到期、跨交易日顺延）只能靠 sleep，既慢又不稳定。
 *  2. 回放数据的 data.timestamp 是录制时固定的。若原样使用，第二天所有数据都会
 *     被判为"过期"而全线降级——演示就废了。因此回放适配器会以本时钟为基准
 *     重写 data.timestamp，使数据"看起来是刚取的"。故障注入再把它推回过去。
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** 测试与演示用：可手动推进的时钟 */
export class ManualClock implements Clock {
  private t: number;
  constructor(startMs: number) {
    this.t = startMs;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

let current: Clock = systemClock;

export function getClock(): Clock {
  return current;
}

export function setClock(c: Clock): void {
  current = c;
}

export function resetClock(): void {
  current = systemClock;
}

export function now(): number {
  return current.now();
}
