/**
 * 回放适配器 —— 默认数据源，无需任何 API Key。
 *
 * 职责：
 *  1. 把逻辑端点映射到 fixtures/fuyao/*.json
 *  2. **按请求参数过滤**（这样评估器的过滤逻辑才会被真正验证，
 *     而不是无论问什么都返回同一份全量数据）
 *  3. 把 data.timestamp 归一化到"刚刚取到"（见下方说明），
 *     使回放数据不会随着真实时间流逝而集体过期
 *  4. 返回与真实扶摇**完全同构**的信封，经同一个 unwrapEnvelope 解包
 *
 * 关于 data.timestamp 归一化：
 *   fixture 录制时写死了当时的时间戳。若不改写，第二天所有数据都会被
 *   STALE 判定击穿，演示就废了。所以这里以注入时钟为基准重写：
 *      data.timestamp = clock.now() - baseAgeMs
 *  默认 baseAgeMs = 0（数据是新鲜的）。故障注入层再把 baseAgeMs 调大，
 *  从而"制造数据过期"——这是 chaos 能确定性复现的前提。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unwrapEnvelope, type SourceResult } from './envelope.js';
import { EP, listKeyFor, type SourceAdapter, type SourceRequest } from './types.js';
import { sanitizeDeep } from './sanitize.js';
import { getClock } from '../clock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', '..', '..', 'fixtures', 'fuyao');

/** 端点 → fixture 文件名（除历史 K 线外，历史按 thscode 分文件） */
const FIXTURE_BY_ENDPOINT: Record<string, string> = {
  [EP.pricesSnapshot]: 'prices_snapshot.json',
  [EP.valuationsSnapshot]: 'valuations_snapshot.json',
  [EP.tradingDays]: 'trading_days.json',
  [EP.hotStockList]: 'hot_stock_list.json',
  [EP.limitUpPool]: 'limit_up_pool.json',
  [EP.limitDownPool]: 'limit_down_pool.json',
  [EP.limitBreakPool]: 'limit_break_pool.json',
  [EP.limitUpLadder]: 'limit_up_ladder.json',
  [EP.dragonTigerList]: 'dragon_tiger_list.json',
  [EP.anomalyAnalysisList]: 'anomaly_analysis_list.json',
  [EP.abnormalMonitorList]: 'abnormal_monitor_list.json',
  [EP.tickerSearch]: 'tickers_search.json',
};

/**
 * 这些端点的 item 支持按 thscode 过滤。
 * 对它们而言"查不到"通常是有意义的业务事实（例如"今天没涨停"），
 * 返回空列表 → 条件为 false，而不是报错。
 */
const FILTERABLE = new Set<string>([
  EP.pricesSnapshot,
  EP.valuationsSnapshot,
  EP.hotStockList,
  EP.limitUpPool,
  EP.limitDownPool,
  EP.limitBreakPool,
  EP.limitUpLadder,
  EP.dragonTigerList,
  EP.anomalyAnalysisList,
  EP.abnormalMonitorList,
]);

export interface ReplayOptions {
  fixtureDir?: string;
  /** 数据年龄（毫秒），chaos 层会调大它来制造"数据过期" */
  baseAgeMs?: number;
  /**
   * 价格类字段的扰动比例。用于扮演「第二个数据源」：
   * 正常情况下为 0（两源一致），conflict 场景下设为 0.0087 制造 0.87% 的偏差。
   * 这是确定性的——同一个比例每次跑出的偏差完全相同。
   */
  perturbPct?: number;
}

export class ReplayAdapter implements SourceAdapter {
  readonly name = 'replay';
  readonly mode = 'replay' as const;
  private cache = new Map<string, any>();
  private dir: string;
  /** 数据年龄偏移；chaos 场景把它调大以模拟过期数据 */
  public baseAgeMs: number;
  /** 价格扰动比例；扮演"第二个数据源"时使用 */
  public perturbPct: number;
  /** 最近一次因合规被丢弃的字段，供审计与测试断言 */
  public lastDropped: { path: string; value: string; reason: string }[] = [];

  constructor(opts: ReplayOptions = {}) {
    this.dir = opts.fixtureDir ?? FIXTURE_DIR;
    this.baseAgeMs = opts.baseAgeMs ?? 0;
    this.perturbPct = opts.perturbPct ?? 0;
  }

  private async load(file: string): Promise<any | null> {
    if (this.cache.has(file)) return this.cache.get(file);
    const p = join(this.dir, file);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(await readFile(p, 'utf8'));
    this.cache.set(file, raw);
    return raw;
  }

  async fetch<T = unknown>(req: SourceRequest): Promise<SourceResult<T>> {
    const { endpoint, params } = req;
    const ctx = { provider: 'replay', endpoint, requestParams: params, mode: 'replay' as const };

    // 解析 fixture 文件
    let file = FIXTURE_BY_ENDPOINT[endpoint];
    if (endpoint === EP.pricesHistorical) {
      const thscode = params.thscode;
      file = thscode ? `prices_historical__${thscode}.json` : undefined;
      if (!thscode) {
        return unwrapEnvelope(
          {
            httpStatus: 200,
            body: { code: 1001, message: 'thscode is required', request_id: rid(endpoint), data: null },
          },
          ctx,
        ) as SourceResult<T>;
      }
    }
    if (endpoint === EP.hotStockRankTrend) {
      // 排名走势无 fixture：这是"数据未就绪"的一个真实来源，如实返回
      return unwrapEnvelope(
        {
          httpStatus: 200,
          body: { code: 3002, message: 'data not ready', request_id: rid(endpoint), data: null },
        },
        ctx,
      ) as SourceResult<T>;
    }

    if (!file) {
      return unwrapEnvelope(
        {
          httpStatus: 200,
          body: { code: 3004, message: `unsupported endpoint ${endpoint}`, request_id: rid(endpoint), data: null },
        },
        ctx,
      ) as SourceResult<T>;
    }

    const fx = await this.load(file);
    if (!fx) {
      return unwrapEnvelope(
        {
          httpStatus: 200,
          body: { code: 3002, message: `fixture ${file} not found`, request_id: rid(endpoint), data: null },
        },
        ctx,
      ) as SourceResult<T>;
    }

    // 深拷贝后改写，避免污染缓存
    const body = JSON.parse(JSON.stringify(fx));
    // 列表所在的键随端点而异（龙虎榜是 stock_items，其余是 item）
    const key = listKeyFor(endpoint);
    let items: any[] = body?.data?.[key] ?? [];

    // 按参数过滤
    const wanted = parseThscodes(params);
    if (FILTERABLE.has(endpoint) && wanted.length > 0) {
      items = items.filter((it) => wanted.includes(String(it.thscode ?? '')));
    }
    if (endpoint === EP.pricesHistorical) {
      items = items.filter((it) => typeof it.date_ms === 'number');
    }
    /**
     * 异动标签：真实服务端按请求参数 `tag_codes` 过滤，响应里**不含**标签代码。
     * 回放没有服务端，只能在本地模拟这个过滤。
     *
     * 这需要 fixture 里的记录带一个标签代码 —— 那是个**回放专用的模拟字段**
     * （fixture 中名为 `_tag_code_mock`），契约里并不存在，也绝不能被当成契约字段。
     * 若 fixture 缺该字段，则**不过滤**并保持原样：宁可少过滤，也不要假装过滤过。
     */
    if (endpoint === EP.anomalyAnalysisList && params.tag_codes) {
      const wanted = params.tag_codes.split(',').map((s) => s.trim()).filter(Boolean);
      const withMock = items.some((it) => typeof it._tag_code_mock === 'string');
      if (withMock) {
        items = items.filter((it) => wanted.includes(String(it._tag_code_mock)));
      }
    }

    // 热榜/涨跌停池的 period 过滤
    if (endpoint === EP.hotStockList && params.period) {
      body.data.period = params.period;
    }

    // 扮演「第二个数据源」时对价格类字段施加确定性扰动
    if (this.perturbPct !== 0) {
      for (const it of items) {
        for (const f of ['last_price', 'close_price', 'prev_price', 'open_price']) {
          if (typeof it[f] === 'number') {
            it[f] = Number((it[f] * (1 + this.perturbPct)).toFixed(4));
          }
        }
      }
    }

    body.data[key] = items;

    // 归一化 data.timestamp：让数据"看起来是刚取的"
    if (typeof body.data.timestamp === 'number' || this.baseAgeMs > 0) {
      body.data.timestamp = getClock().now() - this.baseAgeMs;
    }

    // 出站净化：丢弃数据源附带的预测性文字字段（见 sanitize.ts / TC-D5）
    const { data: cleanBody, dropped } = sanitizeDeep(body);
    if (dropped.length > 0) {
      this.lastDropped = dropped;
    }

    return unwrapEnvelope<T>({ httpStatus: 200, body: cleanBody }, ctx);
  }
}

function parseThscodes(params: Record<string, string>): string[] {
  const raw = params.thscodes ?? params.thscode ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function rid(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = '';
  let x = h;
  for (let i = 0; i < 32; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += (x >>> 28).toString(16);
  }
  return out;
}
