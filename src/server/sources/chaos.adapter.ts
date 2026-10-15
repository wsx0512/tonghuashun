/**
 * 故障注入适配器 —— 让"降级"变得可演示、可测试。
 *
 * 设计要点：它不是凭空造错，而是**包装回放适配器**：先取到确定性的 fixture，
 * 再按场景变异。因此同一个场景每次跑出的结果完全一致——
 * 这是 60–180 秒视频能在有限时长里稳定展示降级能力的前提，
 * 也是 C 组测试用例能确定性断言的前提。
 *
 * 为什么必须在回放层做：真实行情源下你**无法按需制造**「数据过期 3 小时」
 * 或「上游返回 code 5003」。这恰恰是确定性环境的价值所在。
 */

import type { SourceResult } from './envelope.js';
import { unwrapEnvelope } from './envelope.js';
import { EP, type SourceAdapter, type SourceRequest } from './types.js';
import { ReplayAdapter } from './replay.adapter.js';
import { getClock } from '../clock.js';

export type ChaosScenario =
  | 'stale_price' // 数据过期：把 data.timestamp 推回过去
  | 'conflict_price' // 源冲突：由 SourceMesh 的备源扰动实现
  | 'upstream_failure' // 上游故障：code 5003 / 超时
  | 'rate_limited' // 限流：HTTP 429 / code 4001
  | 'not_ready' // 数据未就绪：code 3002
  | 'capability_denied' // 能力未开放：code 2003
  | 'partial_null' // 字段缺失：金额类字段返回 null（不补零）
  | 'empty_data' // code=0 但 data 为空
  | 'malformed'; // 非标准响应（模拟网关错误页）

export interface ChaosState {
  scenario: ChaosScenario | null;
  /** 限定作用范围；为空表示作用于所有端点 */
  endpoints?: string[];
  /** stale 场景下把数据推回多久（毫秒） */
  staleMs?: number;
}

/** 各场景默认作用的端点（不指定时） */
const SCENARIO_SCOPE: Record<ChaosScenario, string[]> = {
  stale_price: [EP.pricesSnapshot, EP.pricesHistorical, EP.valuationsSnapshot],
  conflict_price: [EP.pricesSnapshot],
  upstream_failure: [],
  rate_limited: [],
  not_ready: [EP.anomalyAnalysisList, EP.abnormalMonitorList, EP.hotStockRankTrend],
  capability_denied: [EP.newsEventsSearch],
  partial_null: [EP.pricesSnapshot, EP.valuationsSnapshot],
  empty_data: [EP.pricesSnapshot],
  malformed: [EP.pricesSnapshot],
};

export class ChaosAdapter implements SourceAdapter {
  readonly name = 'chaos';
  readonly mode = 'chaos' as const;
  private inner: ReplayAdapter;
  public state: ChaosState = { scenario: null };

  constructor(inner?: ReplayAdapter) {
    this.inner = inner ?? new ReplayAdapter();
  }

  setScenario(scenario: ChaosScenario | null, opts: { endpoints?: string[]; staleMs?: number } = {}) {
    this.state = { scenario, ...opts };
  }

  clear() {
    this.state = { scenario: null };
    this.inner.baseAgeMs = 0;
  }

  get activeScenario(): ChaosScenario | null {
    return this.state.scenario;
  }

  private applies(endpoint: string): boolean {
    const s = this.state.scenario;
    if (!s) return false;
    const scope = this.state.endpoints ?? SCENARIO_SCOPE[s];
    // 空数组表示"作用于所有端点"
    if (scope.length === 0) return true;
    return scope.includes(endpoint);
  }

  async fetch<T = unknown>(req: SourceRequest): Promise<SourceResult<T>> {
    const { endpoint, params } = req;
    const ctx = { provider: 'chaos', endpoint, requestParams: params, mode: 'chaos' as const };

    if (!this.applies(endpoint)) {
      return this.inner.fetch<T>(req);
    }

    const scenario = this.state.scenario!;

    // ── 短路的错误注入：不取数据，直接返回错误信封 ──
    switch (scenario) {
      case 'upstream_failure':
        return unwrapEnvelope<T>(
          {
            httpStatus: 200,
            body: {
              code: 5003,
              message: 'upstream service unavailable [chaos]',
              request_id: chaosRid(endpoint),
              data: null,
            },
          },
          ctx,
        );

      case 'rate_limited':
        // 两种限流形态都覆盖：HTTP 429 与 code 4001
        return unwrapEnvelope<T>(
          params.__asHttp429 === '1'
            ? { httpStatus: 429, body: { code: 4001, message: 'qps exceeded [chaos]', data: null } }
            : {
                httpStatus: 200,
                body: {
                  code: 4001,
                  message: 'qps exceeded [chaos]',
                  request_id: chaosRid(endpoint),
                  data: null,
                },
              },
          ctx,
        );

      case 'not_ready':
        return unwrapEnvelope<T>(
          {
            httpStatus: 200,
            body: {
              code: 3002,
              message: 'data not ready [chaos]',
              request_id: chaosRid(endpoint),
              data: null,
            },
          },
          ctx,
        );

      case 'capability_denied':
        return unwrapEnvelope<T>(
          {
            httpStatus: 200,
            body: {
              code: 2003,
              message: 'capability not open for external access [chaos]',
              request_id: chaosRid(endpoint),
              data: null,
            },
          },
          ctx,
        );

      case 'empty_data':
        return unwrapEnvelope<T>(
          {
            httpStatus: 200,
            body: { code: 0, message: 'success', request_id: chaosRid(endpoint), data: null },
          },
          ctx,
        );

      case 'malformed':
        // 模拟网关返回 HTML 错误页——HTTP 200 但根本不是信封
        return unwrapEnvelope<T>(
          { httpStatus: 200, body: '<html><body>502 Bad Gateway</body></html>' },
          ctx,
        );

      default:
        break;
    }

    // ── 数据变异类：先取到真实 fixture，再改写 ──
    const base = await this.inner.fetch<T>(req);
    if (!base.ok) return base;

    if (scenario === 'stale_price') {
      const staleMs = this.state.staleMs ?? 3 * 3600 * 1000; // 默认推回 3 小时
      const data = base.data as any;
      if (data && typeof data === 'object' && 'timestamp' in data) {
        data.timestamp = getClock().now() - staleMs;
      }
      return { ...base, dataTimestampMs: (data as any)?.timestamp ?? null };
    }

    if (scenario === 'partial_null') {
      const data = base.data as any;
      const items: any[] = data?.item ?? [];
      for (const it of items) {
        // 金额类字段置空——绝不补零。补零会把"没有数据"伪装成"金额是 0"。
        if ('turnover' in it) it.turnover = null;
        if ('total_market_cap' in it) it.total_market_cap = null;
        if ('float_market_cap' in it) it.float_market_cap = null;
        if ('seal_money' in it) it.seal_money = null;
      }
      return base;
    }

    // conflict_price 由 SourceMesh 通过备源扰动实现，这里直通
    return base;
  }
}

function chaosRid(seed: string): string {
  let h = 0x12345678;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `chaos${h.toString(16).padStart(8, '0')}`;
}
