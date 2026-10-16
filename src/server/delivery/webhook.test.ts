/**
 * 站外推送渠道测试 —— 对应「通知是否真的送出去」这条链路。
 *
 * 这一组用例守护的是一个**特别容易造成误导**的失败模式：
 * 任务触发了、通知也生成了，但用户根本没收到，而系统看起来一切正常。
 * 所以每条失败路径都必须有明确状态，且**内容不合规时宁可拒发**。
 */

import { describe, it, expect, vi } from 'vitest';
import { WebhookChannel, type OutboundNotification } from './webhook.js';

const note = (over: Partial<OutboundNotification> = {}): OutboundNotification => ({
  id: 'ntf_1',
  taskId: 'task_1',
  taskName: '茅台跌破与急涨',
  kind: 'TRIGGERED',
  text: '贵州茅台 当前值 1312.97 元，低于阈值 1200.00 元（数据时点 2026-10-15 15:00）。',
  epistemic: 'fact',
  ...over,
});

const okRes = (status = 200) => ({ ok: true, status }) as any;
const errRes = (status: number) => ({ ok: false, status }) as any;

describe('未配置渠道时不得假装送达', () => {
  it('未配置 → SKIPPED，且根本不会发出请求', async () => {
    const fetchImpl = vi.fn();
    const ch = new WebhookChannel({ url: null, fetchImpl: fetchImpl as any });

    const out = await ch.deliver(note());

    expect(out.status).toBe('SKIPPED');
    expect(out.error).toContain('未配置');
    // 关键：没有任何出站请求
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ch.configured).toBe(false);
  });

  it('空字符串/空白 URL 等同于未配置，而不是"配置了一个空地址"', async () => {
    const fetchImpl = vi.fn();
    for (const url of ['', '   ']) {
      const ch = new WebhookChannel({ url, fetchImpl: fetchImpl as any });
      expect(ch.configured).toBe(false);
      expect((await ch.deliver(note())).status).toBe('SKIPPED');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('describe() 如实报告未配置', () => {
    const ch = new WebhookChannel({ url: null });
    expect(ch.describe().configured).toBe(false);
    expect(ch.describe().label).toContain('未配置');
  });
});

describe('成功投递', () => {
  it('2xx → SENT，一次尝试，并带上认知等级与合规声明', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okRes(200));
    const ch = new WebhookChannel({ url: 'https://example.com/hook', fetchImpl: fetchImpl as any });

    const out = await ch.deliver(note());

    expect(out).toMatchObject({ status: 'SENT', attempts: 1, httpStatus: 200 });

    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body);
    // 认知等级随消息一起送出——收端能区分事实/推断/无法判定
    expect(body.epistemic).toBe('fact');
    // 站外渠道也必须带合规声明，避免被误读为投资建议
    expect(body.compliance).toContain('不构成买卖建议');
    expect(body.event).toBe('TRIGGERED');
    expect(body.task.id).toBe('task_1');
    // 事实字段本身原样保留，不被改写
    expect(body.text).toContain('1312.97');
  });

  it('describe() 不泄露 URL 上的凭据参数', () => {
    const ch = new WebhookChannel({ url: 'https://hooks.example.com/send?token=SECRET123' });
    const { label } = ch.describe();
    expect(label).not.toContain('SECRET123');
    expect(label).toContain('hooks.example.com');
  });
});

describe('失败要留痕，且区分"可重试"与"重试耗尽"', () => {
  it('首次 500、第二次成功 → SENT 且 attempts=2（确实重试过）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errRes(500))
      .mockResolvedValueOnce(okRes(200));
    const ch = new WebhookChannel({
      url: 'https://example.com/hook',
      fetchImpl: fetchImpl as any,
      backoffMs: 0, // 测试里不留真实等待
    });

    const out = await ch.deliver(note());

    expect(out).toMatchObject({ status: 'SENT', attempts: 2, httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('一直 500 → FAILED，尝试次数用满，错误里带 HTTP 状态', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errRes(502));
    const ch = new WebhookChannel({
      url: 'https://example.com/hook',
      fetchImpl: fetchImpl as any,
      maxAttempts: 3,
      backoffMs: 0,
    });

    const out = await ch.deliver(note());

    expect(out.status).toBe('FAILED');
    expect(out.attempts).toBe(3);
    expect(out.httpStatus).toBe(502);
    expect(out.error).toContain('502');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('网络异常 → FAILED，且错误信息保留原因（不吞成"未知错误"）', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:9999'));
    const ch = new WebhookChannel({
      url: 'https://example.com/hook',
      fetchImpl: fetchImpl as any,
      maxAttempts: 1,
      backoffMs: 0,
    });

    const out = await ch.deliver(note());

    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('ECONNREFUSED');
  });

  it('超时被单独识别为"超时"，而不是含糊的网络错误', async () => {
    // 永不 resolve，只在 abort 时 reject —— 模拟一个挂死的上游
    const fetchImpl = vi.fn(
      (_url: string, init: any) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            rej(e);
          });
        }),
    );
    const ch = new WebhookChannel({
      url: 'https://example.com/hook',
      fetchImpl: fetchImpl as any,
      maxAttempts: 1,
      timeoutMs: 30,
      backoffMs: 0,
    });

    const out = await ch.deliver(note());

    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('超时');
  });
});

describe('★ 出站内容仍受合规约束：宁可拒发，也不发出去', () => {
  it('文案命中禁用词 → SKIPPED，且**一个请求都不发**', async () => {
    const fetchImpl = vi.fn();
    const ch = new WebhookChannel({ url: 'https://example.com/hook', fetchImpl: fetchImpl as any });

    const out = await ch.deliver(note({ text: '贵州茅台后市有望突破 1500 元。' }));

    expect(out.status).toBe('SKIPPED');
    expect(out.error).toContain('合规');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('数据源夹带的成功率类表述同样被拦下', async () => {
    const fetchImpl = vi.fn();
    const ch = new WebhookChannel({ url: 'https://example.com/hook', fetchImpl: fetchImpl as any });

    const out = await ch.deliver(note({ text: '普通席位买入，成功率44.94%' }));

    expect(out.status).toBe('SKIPPED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
