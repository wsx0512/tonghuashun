/**
 * 信封守卫测试 —— 对应测试计划 TC-C1 ~ TC-C6。
 *
 * 这组测试守护的是整个系统最容易被写错的一行：
 *      「HTTP 200 不等于业务成功」
 * 一旦有人把 unwrapEnvelope 换成 `if (res.ok)`，这些用例必须立刻变红。
 */

import { describe, it, expect } from 'vitest';
import { unwrapEnvelope, assessFreshness, fmtShanghai } from './envelope.js';

const ctx = {
  provider: 'fuyao',
  endpoint: '/api/a-share/prices/snapshot',
  requestParams: { thscodes: '600519.SH' },
  mode: 'replay' as const,
};

/** 构造一个扶摇风格的响应 */
const fuyao = (code: number, message: string, data: unknown, requestId = 'req-abc123') => ({
  httpStatus: 200,
  body: { code, message, request_id: requestId, data },
});

describe('unwrapEnvelope —— HTTP 200 陷阱', () => {
  it('TC-C1: HTTP 200 + code=2003 必须被判为失败（而非"成功但没数据"）', () => {
    const r = unwrapEnvelope(fuyao(2003, 'Invalid or revoked API key', null), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('CAPABILITY_DENIED');
    expect(r.retryable).toBe(false);
    expect(r.requestId).toBe('req-abc123');
    // 用户可见文案必须明确表示"无法判定"，而不是沉默
    expect(r.userMessage).toContain('不会给出「正常」结论');
  });

  it('TC-C2: HTTP 200 + code=4001（限流）→ RATE_LIMITED 且可重试', () => {
    const r = unwrapEnvelope(fuyao(4001, 'qps exceeded', null), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('RATE_LIMITED');
    expect(r.retryable).toBe(true);
    expect(r.userMessage).toContain('不会被误判为「未触发」');
  });

  it('TC-C2b: HTTP 429 → RATE_LIMITED（HTTP 语义层限流也要覆盖）', () => {
    const r = unwrapEnvelope({ httpStatus: 429, body: {} }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('RATE_LIMITED');
  });

  it('TC-C3: code=3002（数据未就绪）→ NOT_READY，文案须说明"非没有发生"', () => {
    const r = unwrapEnvelope(fuyao(3002, 'data not ready', null), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('NOT_READY');
    expect(r.userMessage).toContain('不等于');
  });

  it('TC-C4: code=5003（数据源不可用）→ FAILURE 且可重试', () => {
    const r = unwrapEnvelope(fuyao(5003, 'upstream unavailable', null), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('FAILURE');
    expect(r.retryable).toBe(true);
  });

  it('TC-C5: HTTP 200 但 body 是网关 HTML 错误页 → MALFORMED_ENVELOPE', () => {
    const r = unwrapEnvelope({ httpStatus: 200, body: '<html>502 Bad Gateway</html>' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('MALFORMED_ENVELOPE');
  });

  it('TC-C5b: 信封缺少数字类型的 code → MALFORMED_ENVELOPE', () => {
    const r = unwrapEnvelope(
      { httpStatus: 200, body: { message: 'ok', request_id: 'x', data: { item: [] } } },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('MALFORMED_ENVELOPE');
  });

  it('TC-C5c: HTTP 500 → FAILURE（不能只看 body，网络层错误同样要拦）', () => {
    const r = unwrapEnvelope({ httpStatus: 500, body: fuyao(0, 'success', { item: [] }).body }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('FAILURE');
  });

  it('code=0 但 data 为 null → EMPTY_DATA（成功信封也可能是空的）', () => {
    const r = unwrapEnvelope(fuyao(0, 'success', null), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('EMPTY_DATA');
  });

  it('参数类错误 1002 → UNSUPPORTED 且不可重试（重试没有意义，要改规则）', () => {
    const r = unwrapEnvelope(fuyao(1002, 'date is not a trading day', null), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasonCode).toBe('UNSUPPORTED');
    expect(r.retryable).toBe(false);
  });

  it('真实成功响应 → ok，且带出 request_id 与 dataTimestampMs', () => {
    const ts = Date.parse('2026-10-15T15:00:00+08:00');
    const r = unwrapEnvelope(
      fuyao(0, 'success', { timestamp: ts, item: [{ thscode: '600519.SH', last_price: 1312.97 }] }),
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.requestId).toBe('req-abc123');
    expect(r.dataTimestampMs).toBe(ts);
    expect((r.data as any).item[0].last_price).toBe(1312.97);
  });

  it('原始响应始终被保留，供证据回链', () => {
    const body = fuyao(5003, 'boom', null).body;
    const r = unwrapEnvelope({ httpStatus: 200, body }, ctx);
    expect(r.raw.body).toBe(body);
    expect(r.raw.endpoint).toBe('/api/a-share/prices/snapshot');
    expect(r.raw.requestParams).toEqual({ thscodes: '600519.SH' });
  });
});

describe('assessFreshness —— 用上游时点而非取数时刻', () => {
  it('TC-C6: 超过阈值判为不新鲜，并给出可读说明', () => {
    const now = Date.parse('2026-10-15T15:30:00+08:00');
    const dataTs = Date.parse('2026-10-15T15:00:00+08:00');
    const r = assessFreshness(dataTs, 5 * 60 * 1000, now);
    expect(r.fresh).toBe(false);
    expect(r.ageMs).toBe(30 * 60 * 1000);
    expect(r.note).toContain('30 分钟');
    expect(r.note).toContain('超过阈值');
  });

  it('阈值内判为新鲜', () => {
    const now = Date.parse('2026-10-15T15:01:00+08:00');
    const dataTs = Date.parse('2026-10-15T15:00:00+08:00');
    const r = assessFreshness(dataTs, 5 * 60 * 1000, now);
    expect(r.fresh).toBe(true);
  });

  it('缺失 data.timestamp 时**不得**默认当作新鲜', () => {
    const r = assessFreshness(null, 60_000);
    expect(r.fresh).toBe(false);
    expect(r.note).toContain('缺失');
  });
});

describe('fmtShanghai', () => {
  it('按上海时区格式化', () => {
    const ts = Date.parse('2026-10-15T15:00:00+08:00');
    expect(fmtShanghai(ts)).toBe('2026-10-15 15:00');
  });
});
