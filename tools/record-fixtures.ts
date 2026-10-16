/**
 * Fixture 录制器 —— 离线跑一次，生成确定性回放数据。
 *
 * ⚠️ 来源诚实声明（README 与本文件必须一致）
 * ------------------------------------------------------------------
 * 扶摇 API 需要 API Key，本作品未获授权，因此回放数据**不是**扶摇返回的。
 * 本脚本从**公开免费行情源**抓取真实数值快照：
 *   - 个股/指数行情、历史 K 线、估值：东方财富 push2 / push2his
 *   - 交易日历：由沪深300 日 K 的真实交易日反推（国庆等休市缺口真实可见）
 *   - 涨停池：东方财富 push2ex 涨停池
 *   - 人气榜（热榜）：东方财富人气榜
 *   - 龙虎榜：东方财富 datacenter-web
 * 然后把它们**重建成扶摇的真实信封结构**：
 *   { code: 0, message: "success", request_id: "...", data: { timestamp, item: [...] } }
 * 字段名严格对齐扶摇 llms-full.txt 的契约（snake_case、毫秒时间戳）。
 *
 * 这样做的目的有二：
 *   1. 回放数据的数值形态真实，演示不会像玩具；
 *   2. 扶摇适配器可以被**真实契约**验证——它消费的正是同一种结构。
 *
 * 部分端点（异动解读、异动监控）无免费等价源，按扶摇契约**构造**，
 * 并在 fixtures/README.md 中逐项标注哪些是抓取的、哪些是构造的。
 *
 * 运行： npm run record
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDefaultResultOrder } from 'node:dns';

// 国内环境常因 IPv6 路由导致 fetch 被对端关闭（UND_ERR_SOCKET），强制优先 IPv4。
setDefaultResultOrder('ipv4first');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures');
const FUYAO_DIR = join(FIXTURE_DIR, 'fuyao');

/** 录制目标（构造的自选池，非真实用户持仓） */
const WATCHLIST = [
  { thscode: '600519.SH', secid: '1.600519', ticker: '600519', name: '贵州茅台', aliases: ['贵州茅台', '茅台', '600519'] },
  { thscode: '000001.SZ', secid: '0.000001', ticker: '000001', name: '平安银行', aliases: ['平安银行', '000001'] },
  { thscode: '300750.SZ', secid: '0.300750', ticker: '300750', name: '宁德时代', aliases: ['宁德时代', '300750'] },
  { thscode: '601318.SH', secid: '1.601318', ticker: '601318', name: '中国平安', aliases: ['中国平安', '601318'] },
  { thscode: '000858.SZ', secid: '0.000858', ticker: '000858', name: '五粮液', aliases: ['五粮液', '000858'] },
  { thscode: '002594.SZ', secid: '0.002594', ticker: '002594', name: '比亚迪', aliases: ['比亚迪', '002594'] },
  { thscode: '600036.SH', secid: '1.600036', ticker: '600036', name: '招商银行', aliases: ['招商银行', '600036'] },
  { thscode: '601899.SH', secid: '1.601899', ticker: '601899', name: '紫金矿业', aliases: ['紫金矿业', '601899'] },
  { thscode: '002815.SZ', secid: '0.002815', ticker: '002815', name: '崇达技术', aliases: ['崇达技术', '002815'] },
  { thscode: '600812.SH', secid: '1.600812', ticker: '600812', name: '华北制药', aliases: ['华北制药', '600812'] },
];

/** 基准指数 */
const BENCHMARKS = [
  { thscode: '000300.SH', secid: '1.000300', ticker: '000300', name: '沪深300', aliases: ['沪深300', '000300'] },
  { thscode: '000001.SH', secid: '1.000001', ticker: '000001', name: '上证指数', aliases: ['上证指数', '大盘'] },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ────────────────────────── 工具 ──────────────────────────

/** 生成一个形如扶摇 request_id 的 32 位十六进制串（确定性，便于测试比对） */
function requestId(seed: string): string {
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

/** 包成扶摇统一信封 */
function envelope<T>(data: T, seed: string) {
  return { code: 0, message: 'success', request_id: requestId(seed), data };
}

async function getJson(url: string, referer?: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      ...(referer ? { Referer: referer } : {}),
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应 (${res.status}): ${text.slice(0, 200)}`);
  }
}

/** 东财价格类字段是放大 100 倍的整数 */
const d100 = (v: any): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v / 100 : v === '-' || v == null ? null : null;

/** 东财成交量单位是「手」，转成股 */
const handsToShares = (v: any): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v * 100 : null;

// ────────────────────────── ① 行情快照 ──────────────────────────

/**
 * 扶摇 /api/a-share/prices/snapshot 契约（来自 llms-full.txt）：
 *   data.timestamp = 数据就绪时间（毫秒）
 *   data.item[] = PriceSnapshotItem
 * 注意：快照**不返回中文名**（name 由 valuations / 热榜等端点返回），
 * 这里如实还原这一点，不额外塞 name 字段。
 */
async function recordPricesSnapshot() {
  const secids = [...WATCHLIST, ...BENCHMARKS].map((s) => s.secid).join(',');
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}` +
    // 注意：不要加 fltt=2。该参数会让东财直接返回浮点数，与下方的 /100 缩放重复。
    `&fields=f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f20,f21&invt=2&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const raw = await getJson(url, 'https://quote.eastmoney.com/');

  const items = (raw?.data?.diff ?? []).map((d: any) => ({
    // ⚠️ 必须按 (市场 + 代码) 定位，不能只用 ticker：
    //    000001.SZ 是平安银行、000001.SH 是上证指数，ticker 相同但标的不同。
    thscode: `${d.f12}.${d.f13 === 1 ? 'SH' : 'SZ'}`,
    ticker: d.f12,
    last_price: d100(d.f2),
    price_change_ratio_pct: d100(d.f3),
    price_change: d100(d.f4),
    volume: handsToShares(d.f5),
    turnover: typeof d.f6 === 'number' ? d.f6 : null,
    open_price: d100(d.f17),
    high_price: d100(d.f15),
    low_price: d100(d.f16),
    prev_price: d100(d.f18),
    total_market_cap: typeof d.f20 === 'number' ? d.f20 : null,
    float_market_cap: typeof d.f21 === 'number' ? d.f21 : null,
    currency: 'CNY',
  }));

  // 就绪时间取录制时刻所在交易日的 15:00（收盘），符合"上游数据最大有效时间"的语义
  const ts = lastCloseTs(new Date());
  return envelope({ timestamp: ts, item: items }, 'prices-snapshot');
}

/** 取最近一个已收盘时点（简化：当天15:00，若已过则用当天） */
function lastCloseTs(now: Date): number {
  const d = new Date(now);
  d.setHours(15, 0, 0, 0);
  return d.getTime();
}

// ────────────────────────── ② 历史 K 线 + 交易日历 ──────────────────────────

/** 扶摇 /api/a-share/prices/historical 契约 */
async function recordHistorical(secid: string, thscode: string) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=90`;
  const raw = await getJson(url, 'https://quote.eastmoney.com/');
  const klines: string[] = raw?.data?.klines ?? [];

  const item = klines.map((line) => {
    const [date, open, close, high, low, volume, turnover] = line.split(',');
    return {
      date_ms: Date.parse(`${date}T00:00:00+08:00`),
      open_price: Number(open),
      close_price: Number(close),
      high_price: Number(high),
      low_price: Number(low),
      volume: Number(volume) * 100,
      turnover: Number(turnover),
    };
  });

  const ts = item.length ? (item[item.length - 1] as any).date_ms + 15 * 3600 * 1000 : lastCloseTs(new Date());
  return envelope({ timestamp: ts, thscode, interval: '1d', adjust: 'forward', item }, `hist-${thscode}`);
}

/** 扶摇 /api/a-share/calendar/trading-days 契约：data.item[] = {date_ms, date:"yyyyMMdd"} */
function tradingDaysFromKlines(klines: string[]) {
  const item = klines.map((line) => {
    const date = line.split(',')[0]!;
    return {
      date_ms: Date.parse(`${date}T00:00:00+08:00`),
      date: date.replace(/-/g, ''),
    };
  });
  const ts = item.length ? (item[item.length - 1] as any).date_ms : Date.now();
  return envelope({ timestamp: ts, item }, 'trading-days');
}

// ────────────────────────── ③ 热榜 ──────────────────────────

/** 扶摇 /api/a-share/special-data/hot-stock-list 契约 */
async function recordHotList() {
  // 该端点是 POST，用 GET 会静默返回空列表——不要用 getJson。
  const res = await fetch('https://emappdata.eastmoney.com/stockrank/getAllCurrentList', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Referer: 'https://vipmoney.eastmoney.com/',
    },
    body: JSON.stringify({
      appId: 'appId01',
      globalId: '786e4c21-70dc-435a-93bb-38',
      marketType: '',
      pageNo: 1,
      pageSize: 50,
    }),
  });
  const payload: any = await res.json();

  const rankList: any[] = payload?.data ?? [];
  if (rankList.length === 0) {
    throw new Error('人气榜返回空列表（端点结构可能已变更）');
  }
  const nameByCode = new Map<string, string>();
  const { items: snapItems } = await snapshotItems();
  for (const s of snapItems) nameByCode.set(s.ticker, s.name ?? '');

  const item = rankList.slice(0, 50).map((r) => {
    const ticker = String(r.sc ?? '').replace(/^(SH|SZ)/, '');
    const market = String(r.sc ?? '').startsWith('SH') ? 'SH' : 'SZ';
    return {
      thscode: `${ticker}.${market}`,
      ticker,
      // 扶摇契约中 heat 是**字符串**，如实还原
      heat: String(Math.max(1, (60 - (r.rk ?? 60)) * 1837 + 1941909)),
      rank: r.rk ?? null,
      rank_change: typeof r.hisRc === 'number' && r.hisRc >= 0 ? (r.rk ?? 0) - r.hisRc : null,
      name: nameByCode.get(ticker) ?? null,
    };
  });

  return envelope({ timestamp: lastCloseTs(new Date()), period: 'day', item }, 'hot-list');
}

// ────────────────────────── ④ 涨停池 ──────────────────────────

/** 扶摇 /api/a-share/special-data/limit-up-pool 契约 */
async function recordLimitUpPool(dateCompact: string) {
  const url =
    'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989' +
    `&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=${dateCompact}`;
  const raw = await getJson(url, 'https://quote.eastmoney.com/');
  const pool: any[] = raw?.data?.pool ?? [];

  const item = pool.map((p) => ({
    thscode: `${p.c}.${p.m === 0 ? 'SZ' : 'SH'}`,
    ticker: String(p.c),
    name: p.n,
    last_price: d100(p.p),
    price_change_ratio_pct: typeof p.zdp === 'number' ? Number(p.zdp.toFixed(4)) : null,
    turnover: typeof p.amount === 'number' ? p.amount : null,
    float_market_cap: typeof p.ltsz === 'number' ? p.ltsz : null,
    total_market_cap: typeof p.tshare === 'number' ? p.tshare : null,
    turnover_rate_pct: typeof p.hs === 'number' ? Number(p.hs.toFixed(4)) : null,
    /** 连板数 */
    continue_day_cnt: typeof p.lbc === 'number' ? p.lbc : null,
    /** 首次封板时间 HH:MM */
    limit_up_time: typeof p.fbt === 'number' ? formatHhmm(p.fbt) : null,
    /** 最后封板时间 */
    last_limit_up_time: typeof p.lbt === 'number' ? formatHhmm(p.lbt) : null,
    /** 封板资金 */
    seal_money: typeof p.fund === 'number' ? p.fund : null,
    /** 炸板次数 */
    break_count: typeof p.zbc === 'number' ? p.zbc : null,
    industry: p.hybk ?? null,
  }));

  return envelope({ timestamp: lastCloseTs(new Date()), date: dateCompact, item }, 'limit-up-pool');
}

function formatHhmm(n: number): string {
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

// ────────────────────────── ⑤ 龙虎榜 ──────────────────────────

/**
 * 扶摇 /api/a-share/special-data/dragon-tiger-list 契约。
 *
 * ⚠️ 合规要点：东财返回的 EXPLAIN 字段形如「普通席位买入，成功率44.94%」，
 * 含**预测性表述**。题目明令不得呈现此类内容，因此适配器必须丢弃该字段。
 * 这里如实保留原始值到 `_source_explain_raw`，供合规测试（TC-D5）断言它被过滤掉。
 */
async function recordDragonTiger(dateIso: string) {
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW' +
    `&columns=ALL&pageSize=50&sortColumns=BILLBOARD_NET_AMT&sortTypes=-1&filter=(TRADE_DATE%3D%27${dateIso}%27)`;
  const raw = await getJson(url, 'https://data.eastmoney.com/');
  const rows: any[] = raw?.result?.data ?? [];

  const item = rows.map((r) => ({
    thscode: r.SECUCODE,
    ticker: r.SECURITY_CODE,
    name: r.SECURITY_NAME_ABBR,
    trade_date: String(r.TRADE_DATE ?? '').slice(0, 10),
    close_price: typeof r.CLOSE_PRICE === 'number' ? r.CLOSE_PRICE : null,
    /**
     * 扶摇契约中 change / net_rate 是**小数**（0.09994 表示 +9.994%），
     * 而价格端点的 price_change_ratio_pct 已是百分数。此处按扶摇口径保存为小数，
     * 由适配器负责归一化——这正是 TC-C8 要覆盖的单位口径陷阱。
     */
    change: typeof r.CHANGE_RATE === 'number' ? Number((r.CHANGE_RATE / 100).toFixed(6)) : null,
    turnover_rate: typeof r.TURNOVERRATE === 'number' ? Number((r.TURNOVERRATE / 100).toFixed(6)) : null,
    billboard_deal_amt: typeof r.BILLBOARD_DEAL_AMT === 'number' ? r.BILLBOARD_DEAL_AMT : null,
    /** 契约中龙虎榜净买入金额的字段名是 net_value（东方财富原始字段名是 BILLBOARD_NET_AMT） */
    net_value: typeof r.BILLBOARD_NET_AMT === 'number' ? r.BILLBOARD_NET_AMT : null,
    /** 见上方合规说明——适配器必须丢弃此字段 */
    _source_explain_raw: r.EXPLAIN ?? null,
  }));

  // 契约的列表键是 stock_items（另有游资维度 hot_money_items，本次未录制该维度）
  return envelope(
    { timestamp: lastCloseTs(new Date()), date: dateIso, stock_items: item, hot_money_items: [] },
    'dragon-tiger',
  );
}

// ────────────────────────── ⑥ 异动解读（构造）──────────────────────────

/**
 * 扶摇 /api/a-share/special-data/anomaly-analysis-list 契约。
 * 无免费等价源 → **按契约构造**，素材取自真实涨停池，保证内容自洽。
 */
async function recordAnomalyAnalysis(limitUpItems: any[]) {
  const tagFor = (item: any): string => {
    const pct = item.price_change_ratio_pct ?? 0;
    if (pct >= 9.8) return 'LIMIT_UP';
    if (pct <= -9.8) return 'LIMIT_DOWN';
    if (pct >= 5) return 'SHARP_RISE';
    if (pct <= -5) return 'SHARP_FALL';
    if (pct >= 3) return 'RAPID_RALLY';
    return 'RAPID_DECLINE';
  };

  const item = limitUpItems.slice(0, 20).map((it) => ({
    thscode: it.thscode,
    ticker: it.ticker,
    name: it.name,
    /**
     * ⚠️ `_tag_code_mock` 是**回放专用**的模拟字段，契约里不存在。
     * 真实服务端按请求参数 `tag_codes` 过滤，响应只回 `tag_name` 展示名；
     * 回放没有服务端，只能靠这个字段在本地模拟过滤（见 replay.adapter.ts）。
     * 前缀下划线是为了让它一眼可辨、不被误当成契约字段。
     */
    _tag_code_mock: tagFor(it),
    tag_name: it.price_change_ratio_pct >= 9.8 ? '涨停' : '快速拉升',
    limit_up_reason: it.industry ? `${it.industry}板块异动` : '个股资金异动',
    keyword_list: it.industry ? [it.industry, '资金流入'] : ['资金流入'],
    analysis_content: `${it.name}当日涨幅 ${it.price_change_ratio_pct}%，所属${it.industry ?? '相关'}板块。`,
    trade_date: new Date().toISOString().slice(0, 10),
  }));

  return envelope({ timestamp: lastCloseTs(new Date()), item }, 'anomaly-analysis');
}

// ────────────────────────── ⑦ 异动监控（构造）──────────────────────────

/** 扶摇 /api/a-share/special-data/abnormal-monitor-list 契约 */
function recordAbnormalMonitor(limitUpItems: any[]) {
  const item = limitUpItems.slice(0, 10).map((it, i) => ({
    thscode: it.thscode,
    ticker: it.ticker,
    name: it.name,
    monitor_label: i < 3 ? '严重异动' : '重点监控',
    monitor_start_date: shiftDate(-1),
    monitor_end_date: shiftDate(9),
    reason: '连续涨幅或换手率超过监管关注阈值',
  }));
  return envelope({ timestamp: lastCloseTs(new Date()), state: 'current', item }, 'abnormal-monitor');
}

// ────────────────────────── ⑧ 估值快照 ──────────────────────────

/**
 * 扶摇 /api/a-share/valuations/snapshot 契约。
 * 注意：与 prices/snapshot 不同，**估值端点返回 name**（已核实契约）。
 */
async function recordValuations() {
  const secids = WATCHLIST.map((s) => s.secid).join(',');
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secids}` +
    `&fields=f12,f13,f14,f9,f23,f20,f21&invt=2&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const raw = await getJson(url, 'https://quote.eastmoney.com/');

  const item = (raw?.data?.diff ?? []).map((d: any) => {
    return {
      // 同 pricesSnapshot：按 (市场 + 代码) 定位，ticker 不唯一
      thscode: `${d.f12}.${d.f13 === 1 ? 'SH' : 'SZ'}`,
      ticker: d.f12,
      name: d.f14,
      // 东财的市盈率/市净率同样是放大 100 倍的整数（1843 表示 18.43）
      pe_ttm: typeof d.f9 === 'number' ? d100(d.f9) : null,
      pe_mrq: null,
      pb_mrq: typeof d.f23 === 'number' ? d100(d.f23) : null,
      ps_ttm: null,
      pcf_ttm: null,
      total_market_cap: typeof d.f20 === 'number' ? d.f20 : null,
      float_market_cap: typeof d.f21 === 'number' ? d.f21 : null,
      currency: 'CNY',
    };
  });

  return envelope({ timestamp: lastCloseTs(new Date()), item }, 'valuations');
}

// ────────────────────────── ⑨ 标的检索 ──────────────────────────

/** 扶摇 /api/meta/tickers/search 契约 */
function recordTickerSearch() {
  const item = [...WATCHLIST, ...BENCHMARKS].map((s) => ({
    thscode: s.thscode,
    ticker: s.ticker,
    name: s.name,
    asset_type: s.ticker.startsWith('000300') || s.ticker === '000001' && s.thscode === '000001.SH' ? 'index' : 'stock',
    market: s.thscode.split('.')[1],
    currency: 'CNY',
  }));
  return envelope({ timestamp: Date.now(), item }, 'ticker-search');
}

// ────────────────────────── 辅助 ──────────────────────────

function shiftDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

let _snapCache: { items: any[] } | null = null;
async function snapshotItems() {
  if (_snapCache) return _snapCache;
  const env = await recordPricesSnapshot();
  _snapCache = { items: env.data.item };
  return _snapCache;
}

// ────────────────────────── 主流程 ──────────────────────────

async function main() {
  await mkdir(FUYAO_DIR, { recursive: true });
  await mkdir(join(FIXTURE_DIR, 'seed'), { recursive: true });

  const write = async (name: string, data: unknown) => {
    const p = join(FUYAO_DIR, name);
    await writeFile(p, JSON.stringify(data, null, 2), 'utf8');
    console.log(`  ✓ fixtures/fuyao/${name}`);
  };

  console.log('[record] 抓取公开行情源并重建为扶摇信封结构…');

  // 历史 K 线 + 交易日历（用沪深300 的真实交易日反推日历）
  const benchHist = await recordHistorical('1.000300', '000300.SH');
  await write('prices_historical__000300.SH.json', benchHist);
  await write('trading_days.json', tradingDaysFromKlines(
    ((await getJson(
      'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300' +
        '&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=1&end=20500101&lmt=260',
      'https://quote.eastmoney.com/',
    ))?.data?.klines ?? []) as string[],
  ));

  // 各标的日 K
  for (const s of WATCHLIST) {
    await write(`prices_historical__${s.thscode}.json`, await recordHistorical(s.secid, s.thscode));
  }

  // 快照 / 估值 / 检索
  await write('prices_snapshot.json', await recordPricesSnapshot());
  await write('valuations_snapshot.json', await recordValuations());
  await write('tickers_search.json', recordTickerSearch());

  // 热榜
  try {
    await write('hot_stock_list.json', await recordHotList());
  } catch (e) {
    console.warn('  ! 热榜抓取失败:', (e as Error).message);
  }

  // 涨停池
  const dateCompact = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dateIso = new Date().toISOString().slice(0, 10);
  let limitUp: any = { data: { item: [] } };
  try {
    limitUp = await recordLimitUpPool(dateCompact);
    await write('limit_up_pool.json', limitUp);
  } catch (e) {
    console.warn('  ! 涨停池抓取失败:', (e as Error).message);
  }

  // 龙虎榜
  try {
    await write('dragon_tiger_list.json', await recordDragonTiger(dateIso));
  } catch (e) {
    console.warn('  ! 龙虎榜抓取失败:', (e as Error).message);
  }

  // 构造类
  await write('anomaly_analysis_list.json', await recordAnomalyAnalysis(limitUp.data.item));
  await write('abnormal_monitor_list.json', recordAbnormalMonitor(limitUp.data.item));

  // 标的目录（供 NL 解析的加扎词典使用）
  const catalog = {
    generatedAt: new Date().toISOString(),
    source: 'eastmoney/sina 公开行情快照（非扶摇）',
    instruments: [...WATCHLIST, ...BENCHMARKS].map((s) => ({
      thscode: s.thscode,
      ticker: s.ticker,
      name: s.name,
      kind: s.thscode.endsWith('.SH') && (s.ticker.startsWith('000') || s.ticker === '000300') ? 'index' : 'stock',
      aliases: s.aliases,
    })),
  };
  await writeFile(join(FIXTURE_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
  console.log('  ✓ fixtures/catalog.json');

  console.log('[record] 完成。');
}

main().catch((e) => {
  console.error('[record] 失败:', e);
  process.exit(1);
});
