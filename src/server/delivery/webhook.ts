/**
 * 站外推送渠道（Webhook）。
 *
 * 为什么需要它：哨兵的核心承诺是「长期运行的监控任务」。但一个只在浏览器里弹提示的
 * 监控产品，用户关掉页面就等于没监控——「长期运行」也就成了空话。这一层把命中结果
 * 送到浏览器之外。
 *
 * 三个刻意的设计约束，都源自本项目的立身之本：
 *
 *  1. **未配置渠道不是"成功"**。没有配 `SENTINEL_WEBHOOK_URL` 时，投递记为
 *     `SKIPPED` 并写明原因，而不是静默跳过。用户必须能回答「我为什么没收到」。
 *
 *  2. **失败必须留痕**。重试耗尽后记为 `FAILED`，带上尝试次数、HTTP 状态与最后一次
 *     错误。绝不吞掉——吞掉就等于"触发了但假装没触发"。
 *
 *  3. **出站内容仍受合规约束**。模板生成时已经过禁用词扫描，这里**再扫一遍**：
 *     面向站外渠道的文案一旦命中禁用词，宁可**拒发**并记为失败，也不发出去。
 *     这是纵深防御——模板没错不代表将来也不会错。
 */

import { scan } from '../../shared/compliance/banned.js';

export interface OutboundNotification {
  id: string;
  taskId: string;
  taskName?: string;
  kind: string;
  text: string;
  epistemic: 'fact' | 'inference' | 'unknown' | string;
}

export interface DeliveryOutcome {
  /** SENT=已送达 / FAILED=重试耗尽仍失败 / SKIPPED=没配渠道或内容被合规拦下 */
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  attempts: number;
  httpStatus?: number | null;
  error?: string | null;
}

export interface WebhookOptions {
  /** 目标地址；为空表示未配置渠道 */
  url?: string | null;
  /** 总尝试次数（含首次），默认 3 */
  maxAttempts?: number;
  /** 单次请求超时（毫秒），默认 5000 */
  timeoutMs?: number;
  /** 退避基数（毫秒），第 n 次重试前等 base * n，测试里传 0 以保持确定性 */
  backoffMs?: number;
  /** 注入 fetch，便于测试与离线演示 */
  fetchImpl?: typeof fetch;
}

export class WebhookChannel {
  readonly name = 'webhook';
  private url: string | null;
  private maxAttempts: number;
  private timeoutMs: number;
  private backoffMs: number;
  private fetchImpl: typeof fetch;

  /** 最近一次投递失败的详情，供测试与审计断言 */
  public lastError: string | null = null;

  constructor(opts: WebhookOptions = {}) {
    this.url = opts.url?.trim() || null;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.backoffMs = opts.backoffMs ?? 500;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  get configured(): boolean {
    return this.url !== null;
  }

  /** 渠道的人类可读状态，用于界面与 README 里如实展示 */
  describe(): { configured: boolean; label: string } {
    return this.configured
      ? { configured: true, label: `Webhook（${maskUrl(this.url!)}）` }
      : { configured: false, label: '未配置站外推送渠道（仅站内通知）' };
  }

  buildPayload(n: OutboundNotification): Record<string, unknown> {
    return {
      // 事实性字段，不含任何预测或建议
      event: n.kind,
      task: { id: n.taskId, name: n.taskName ?? null },
      // 结论的认知等级随消息一起送出，收端能区分事实/推断/无法判定
      epistemic: n.epistemic,
      text: n.text,
      // 与 /api/meta 同一句声明，避免站外渠道被误读为投资建议
      compliance: '本产品不预测涨跌、不承诺收益、不构成买卖建议。',
      sentAt: new Date().toISOString(),
    };
  }

  async deliver(n: OutboundNotification): Promise<DeliveryOutcome> {
    if (!this.configured) {
      this.lastError = '未配置 SENTINEL_WEBHOOK_URL，未投递';
      return { status: 'SKIPPED', attempts: 0, error: this.lastError };
    }

    // 纵深防御：站外文案再过一次禁用词扫描
    const violations = scan(n.text);
    if (violations.length > 0) {
      this.lastError = `文案未通过合规扫描：${violations.map((v) => v.label).join('、')}`;
      return { status: 'SKIPPED', attempts: 0, error: this.lastError };
    }

    const payload = this.buildPayload(n);
    let lastErr: string | null = null;
    let lastStatus: number | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1 && this.backoffMs > 0) {
        await sleep(this.backoffMs * (attempt - 1));
      }
      const res = await this.attempt(payload);
      lastStatus = res.httpStatus;
      if (res.ok) {
        this.lastError = null;
        return { status: 'SENT', attempts: attempt, httpStatus: res.httpStatus };
      }
      lastErr = res.error;
    }

    this.lastError = lastErr;
    return { status: 'FAILED', attempts: this.maxAttempts, httpStatus: lastStatus, error: lastErr };
  }

  private async attempt(payload: unknown): Promise<{ ok: boolean; httpStatus: number | null; error: string | null }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      if (res.ok) return { ok: true, httpStatus: res.status, error: null };
      return { ok: false, httpStatus: res.status, error: `HTTP ${res.status}` };
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? `超时（${this.timeoutMs}ms）` : e.message) : String(e);
      return { ok: false, httpStatus: null, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 日志与界面里不要把完整 URL 暴露出去（可能带 token 查询参数） */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '（地址格式无法解析）';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
