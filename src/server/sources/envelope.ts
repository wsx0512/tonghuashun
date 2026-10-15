/**
 * 扶摇统一响应信封的解包与错误分类。
 *
 * ★★★ 这是整个数据层最重要的文件 ★★★
 *
 * 扶摇 API 有一个致命特性（已实测确认）：
 *      **所有业务响应都返回 HTTP 200，业务错误藏在响应体的 `code` 字段里。**
 *
 * 实测：
 *     无 key 调用  → HTTP 200 + {"code":2003,"message":"Missing X-api-key",...}
 *     不存在的路径 → HTTP 200
 *
 * 意味着任何 `if (res.ok)` 的写法都会把「认证失败」「限流」「上游宕机」
 * **静默当成成功**，进而把「没拿到数据」误报成「条件未触发」——
 * 这恰恰违反题目硬性要求「数据缺失、冲突、过期或调用失败时不得静默生成正常结论」。
 *
 * 因此：**全系统只允许在本文件里解包扶摇响应**，其余任何地方都不得直接读 `code`。
 * 对应测试：TC-C1 ~ TC-C5。
 */

import type { ReasonCode } from '../../shared/dsl/types.js';

// ────────────────────────────── 结果类型 ──────────────────────────────

export interface RawRef {
  /** 指向 raw_responses 表的主键，用于证据回链 */
  id: string;
  provider: string;
  endpoint: string;
  requestParams: Record<string, string>;
  httpStatus: number;
  /** 原始 body（可能很大，落库时截断） */
  body: unknown;
  retrievedAt: number;
  mode: 'live' | 'replay' | 'chaos';
}

export interface SourceOk<T> {
  ok: true;
  data: T;
  /** 扶摇信封的 request_id —— 天然的追溯锚点 */
  requestId: string | null;
  /** 上游数据的最大有效时间（毫秒）。注意：这是 data.timestamp，不是取数时刻 */
  dataTimestampMs: number | null;
  raw: RawRef;
}

export interface SourceErr {
  ok: false;
  reasonCode: ReasonCode;
  /** 面向开发者的技术描述（含 code 与 message） */
  message: string;
  /** 面向用户的中文解释，直接可展示 */
  userMessage: string;
  requestId: string | null;
  /** 是否值得重试（限流与上游故障可重试，参数错误与权限问题不可） */
  retryable: boolean;
  raw: RawRef;
}

export type SourceResult<T> = SourceOk<T> | SourceErr;

// ────────────────────────────── 扶摇错误码 ──────────────────────────────

export const FUYAO_CODES: Record<number, string> = {
  1001: '缺少必填参数',
  1002: '参数格式错误',
  1003: '参数取值越界',
  1004: '参数冲突',
  2001: '未认证',
  2003: '权限不足',
  3001: '标的不存在',
  3002: '数据未就绪',
  3004: '标的类型不支持该能力',
  4001: '频率超限',
  5001: '服务内部错误',
  5002: '上游服务超时',
  5003: '数据源不可用',
};

interface Classification {
  reasonCode: ReasonCode;
  retryable: boolean;
  userMessage: (code: number, message: string) => string;
}

/**
 * 把扶摇业务错误码映射到降级原因。
 *
 * 分类原则：
 *  - 参数类（1001–1004）是我们自己的 bug → UNSUPPORTED，不重试，必须修规则
 *  - 认证/权限（2001/2003）→ CAPABILITY_DENIED，不重试，全局告警
 *  - 标的/就绪/类型（3001/3002/3004）→ 区分对待：3002 是"暂时没有"而非"没有"
 *  - 限流（4001）→ RATE_LIMITED，可重试
 *  - 上游（5001/5002/5003）→ FAILURE，可重试
 */
export function classifyError(
  code: number,
  message: string,
  requestId: string | null,
  raw: RawRef,
): SourceErr {
  const cls = classify(code);
  return {
    ok: false,
    reasonCode: cls.reasonCode,
    message: `扶摇业务错误 code=${code} (${FUYAO_CODES[code] ?? '未知'}): ${message}${
      requestId ? ` [request_id=${requestId}]` : ''
    }`,
    userMessage: cls.userMessage(code, message),
    requestId,
    retryable: cls.retryable,
    raw,
  };
}

function classify(code: number): Classification {
  switch (code) {
    case 1001:
    case 1002:
    case 1003:
    case 1004:
      return {
        reasonCode: 'UNSUPPORTED',
        retryable: false,
        userMessage: (c) =>
          `⚠ 规则的取数参数不合法（code ${c}：${FUYAO_CODES[c]}），该条件无法评估。请检查规则中的标的与窗口设置。`,
      };
    case 2001:
    case 2003:
      return {
        reasonCode: 'CAPABILITY_DENIED',
        retryable: false,
        userMessage: (c) =>
          `⚠ 数据能力不可用（code ${c}：${FUYAO_CODES[c]}）。该接口可能未开放外部接入或凭证无效，相关任务已暂停，不会给出「正常」结论。`,
      };
    case 3001:
      return {
        reasonCode: 'EMPTY_DATA',
        retryable: false,
        userMessage: () => `⚠ 标的不存在，请检查规则中填写的代码或名称是否正确。`,
      };
    case 3002:
      return {
        reasonCode: 'NOT_READY',
        retryable: true,
        userMessage: () =>
          `ℹ 数据尚未就绪（code 3002）。该条件本次无法判定——注意这**不等于**「没有发生」。稍后会重新评估。`,
      };
    case 3004:
      return {
        reasonCode: 'UNSUPPORTED',
        retryable: false,
        userMessage: (c) =>
          `⚠ 该标的类型不支持所请求的能力（code ${c}：${FUYAO_CODES[c]}）。请修改规则中的指标或标的。`,
      };
    case 4001:
      return {
        reasonCode: 'RATE_LIMITED',
        retryable: true,
        userMessage: () =>
          `⏳ 触发接口限流（code 4001）。已按退避策略延后重试，本次评估暂缓，不会被误判为「未触发」。`,
      };
    case 5001:
    case 5002:
    case 5003:
      return {
        reasonCode: 'FAILURE',
        retryable: true,
        userMessage: (c) =>
          `⚠ 上游数据服务异常（code ${c}：${FUYAO_CODES[c]}）。本次无法取得数据，该条件无法判定，任务进入降级状态。`,
      };
    default:
      return {
        reasonCode: 'FAILURE',
        retryable: true,
        userMessage: (c) => `⚠ 数据服务返回未知错误（code ${c}）。本次无法判定。`,
      };
  }
}

// ────────────────────────────── 解包 ──────────────────────────────

export interface RawResponse {
  httpStatus: number;
  body: unknown;
}

/**
 * 解包扶摇响应。**全系统唯一的解包入口。**
 *
 * 注意下面每一步都不可省：
 *  - 先看 HTTP 429（限流有独立的 HTTP 语义）
 *  - 再看 HTTP 非 200（网络层错误也要覆盖，不能只信 body）
 *  - 再看 body 是否为合法信封（防止网关返回 HTML 错误页被当成数据）
 *  - 再看 code 是否为 0（**这就是"HTTP 200 陷阱"的防线**）
 *  - 最后看 data 是否为空
 */
export function unwrapEnvelope<T = unknown>(
  raw: RawResponse,
  ctx: { provider: string; endpoint: string; requestParams: Record<string, string>; mode: RawRef['mode'] },
): SourceResult<T> {
  const rawRef: RawRef = {
    id: `${ctx.provider}:${ctx.endpoint}:${Date.now().toString(36)}`,
    provider: ctx.provider,
    endpoint: ctx.endpoint,
    requestParams: ctx.requestParams,
    httpStatus: raw.httpStatus,
    body: raw.body,
    retrievedAt: Date.now(),
    mode: ctx.mode,
  };

  // ① 限流：HTTP 语义层
  if (raw.httpStatus === 429) {
    return {
      ok: false,
      reasonCode: 'RATE_LIMITED',
      message: `HTTP 429 Too Many Requests`,
      userMessage:
        '⏳ 触发接口限流（HTTP 429）。已按退避策略延后重试，本次评估暂缓，不会被误判为「未触发」。',
      requestId: null,
      retryable: true,
      raw: rawRef,
    };
  }

  // ② 非 200
  if (raw.httpStatus !== 200) {
    return {
      ok: false,
      reasonCode: 'FAILURE',
      message: `HTTP ${raw.httpStatus}`,
      userMessage: `⚠ 数据服务返回 HTTP ${raw.httpStatus}，本次无法取得数据，该条件无法判定。`,
      requestId: null,
      retryable: raw.httpStatus >= 500,
      raw: rawRef,
    };
  }

  // ③ 信封结构校验 —— 防止网关的 HTML 错误页被当成数据
  const body = raw.body as any;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      reasonCode: 'MALFORMED_ENVELOPE',
      message: `响应不是对象（收到 ${Array.isArray(body) ? 'array' : typeof body}）`,
      userMessage:
        '⚠ 数据服务返回了非标准响应（可能是网关错误页），本次无法判定，不会给出「正常」结论。',
      requestId: null,
      retryable: true,
      raw: rawRef,
    };
  }

  const { code, message, request_id, data } = body;

  if (typeof code !== 'number') {
    return {
      ok: false,
      reasonCode: 'MALFORMED_ENVELOPE',
      message: `信封缺少数字类型的 code 字段（实际收到 ${JSON.stringify(code)}）`,
      userMessage:
        '⚠ 数据服务返回了非标准响应（缺少 code 字段），本次无法判定，不会给出「正常」结论。',
      requestId: typeof request_id === 'string' ? request_id : null,
      retryable: true,
      raw: rawRef,
    };
  }

  // ④ ★ 核心防线：HTTP 200 但业务 code 非 0 ★
  if (code !== 0) {
    return classifyError(code, String(message ?? ''), request_id ?? null, rawRef);
  }

  // ⑤ data 为空
  if (data === null || data === undefined) {
    return {
      ok: false,
      reasonCode: 'EMPTY_DATA',
      message: 'code=0 但 data 为 null',
      userMessage: 'ℹ 接口返回成功但内容为空，该条件本次无法判定。',
      requestId: request_id ?? null,
      retryable: true,
      raw: rawRef,
    };
  }

  // ⑥ 成功。dataTimestampMs 取 data.timestamp（上游数据有效时间），
  //    这是 stale 判定的锚点 —— 绝不能用 Date.now()。
  const dataTimestampMs =
    typeof (data as any)?.timestamp === 'number' ? (data as any).timestamp : null;

  return {
    ok: true,
    data: data as T,
    requestId: typeof request_id === 'string' ? request_id : null,
    dataTimestampMs,
    raw: rawRef,
  };
}

// ────────────────────────────── 陈旧度判定 ──────────────────────────────

/**
 * 判定数据是否过期。
 *
 * 关键：用上游的 data.timestamp 作锚点，而不是本地取数时刻。
 * 「响应是刚刚收到的」不代表「数据是新的」——上游可能一直在返回几小时前的快照。
 */
export function assessFreshness(
  dataTimestampMs: number | null,
  thresholdMs: number,
  now: number = Date.now(),
): { fresh: boolean; ageMs: number | null; note?: string } {
  if (dataTimestampMs === null) {
    return { fresh: false, ageMs: null, note: '上游未提供数据时点（data.timestamp 缺失）' };
  }
  const ageMs = now - dataTimestampMs;
  if (ageMs > thresholdMs) {
    return {
      fresh: false,
      ageMs,
      note: `数据时点距今 ${Math.round(ageMs / 60000)} 分钟，超过阈值 ${Math.round(
        thresholdMs / 60000,
      )} 分钟`,
    };
  }
  return { fresh: true, ageMs };
}

/** 格式化为可读的上海时区时间，用于面向用户的文案 */
export function fmtShanghai(ms: number | null): string {
  if (ms === null) return '未知时点';
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}`;
}
