/**
 * 多源合并与冲突检测。
 *
 * 现实约束：不同数据源对同一字段可能给出不同数值。题目要求
 * 「数据冲突时不得静默生成结论」——所以这里的原则是：
 *   **两个值都展示，不静默二选一。**
 *
 * 默认策略 `primary_with_flag`：采用主源数值但标注冲突，任务仍进 DEGRADED。
 * 可配置 `require_agreement`：冲突时直接判为无法判定（更保守）。
 *
 * 关于本作品的备源：主源是回放 fixture（扶摇契约），备源是同一个 fixture
 * 加上一个**确定性扰动**，用于扮演"第二个数据源"。这不是真实的第二数据源，
 * README 中已如实说明——它的作用是让冲突检测这条链路可演示、可测试。
 */

import type { SourceResult } from './envelope.js';
import type { SourceAdapter, SourceRequest } from './types.js';

/** 参与冲突比对的字段。注意这里只比"原生单位相同"的字段——
 *  跨单位比较（如龙虎榜的 change 小数 vs 价格的百分数）会制造**假冲突**，
 *  必须在进入比较之前完成归一化（见 shared/units.ts 与 TC-C8）。 */
const COMPARABLE_FIELDS = ['last_price', 'close_price', 'prev_price', 'open_price'] as const;

export interface FieldComparison {
  thscode: string;
  field: string;
  valueA: number;
  sourceA: string;
  valueB: number;
  sourceB: string;
  deltaPct: number;
}

export interface MeshOutcome<T> {
  primary: SourceResult<T>;
  conflicts: FieldComparison[];
  /** 备源是否参与（未配置或备源失败时为 false） */
  secondaryUsed: boolean;
  tolerancePct: number;
}

export interface SourceMeshOptions {
  primary: SourceAdapter;
  /** 备源。为空表示单源模式（无冲突检测）。 */
  secondary?: SourceAdapter | undefined;
  /** 冲突容忍度（相对偏差），默认 0.5% */
  tolerancePct?: number;
  /** true=冲突时强制判为无法判定；false=采用主源并标注 */
  requireAgreement?: boolean;
}

export class SourceMesh {
  constructor(private opts: SourceMeshOptions) {}

  get tolerancePct(): number {
    return this.opts.tolerancePct ?? 0.005;
  }

  get requireAgreement(): boolean {
    return this.opts.requireAgreement ?? false;
  }

  /**
   * 取数。主源永远是权威；备源只用于**发现分歧**，不用于替换主源数值。
   * 这样即使备源不可靠，主链路也不受影响——备源失败只降级为"无冲突检测"。
   */
  async fetch<T = unknown>(req: SourceRequest): Promise<MeshOutcome<T>> {
    const primary = await this.opts.primary.fetch<T>(req);

    const empty: MeshOutcome<T> = {
      primary,
      conflicts: [],
      secondaryUsed: false,
      tolerancePct: this.tolerancePct,
    };

    if (!this.opts.secondary || !primary.ok) return empty;

    const secondary = await this.opts.secondary.fetch<T>(req);
    // 备源失败不升级为错误——它只是没参与比对
    if (!secondary.ok) return empty;

    const conflicts = compareItems(
      (primary.data as any)?.item,
      (secondary.data as any)?.item,
      this.opts.primary.name,
      this.opts.secondary.name,
      this.tolerancePct,
    );

    return { primary, conflicts, secondaryUsed: true, tolerancePct: this.tolerancePct };
  }
}

/** 比对两组 item，找出超出容忍度的字段分歧 */
export function compareItems(
  a: any[] | undefined,
  b: any[] | undefined,
  nameA: string,
  nameB: string,
  tolerancePct: number,
): FieldComparison[] {
  if (!Array.isArray(a) || !Array.isArray(b)) return [];

  const byCodeB = new Map<string, any>();
  for (const it of b) byCodeB.set(String(it?.thscode ?? ''), it);

  const out: FieldComparison[] = [];
  for (const itA of a) {
    const code = String(itA?.thscode ?? '');
    const itB = byCodeB.get(code);
    if (!itB) continue;

    for (const f of COMPARABLE_FIELDS) {
      const va = itA[f];
      const vb = itB[f];
      if (typeof va !== 'number' || typeof vb !== 'number') continue;
      if (va === 0 && vb === 0) continue;

      const denom = Math.max(Math.abs(va), Math.abs(vb));
      if (denom === 0) continue;
      const deltaPct = Math.abs(va - vb) / denom;

      if (deltaPct > tolerancePct) {
        out.push({
          thscode: code,
          field: f,
          valueA: va,
          sourceA: nameA,
          valueB: vb,
          sourceB: nameB,
          deltaPct: Number(deltaPct.toFixed(6)),
        });
      }
    }
  }
  return out;
}
