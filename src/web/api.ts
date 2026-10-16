/** 前端 API 客户端。类型与后端契约对齐，避免各处手写形状。 */

export interface TaskSummary {
  id: string;
  name: string;
  state: string;
  reasonCode: string | null;
  ruleVersion: number | null;
  ruleText: string | null;
  summary: string | null;
  nextRunAt: number | null;
  cooldownUntil: number | null;
  recentTriggered: number;
  suppressedCount: number;
  lastNarrative: string | null;
}

export interface Observation {
  label: string;
  field: string;
  value: number | string | null;
  unit: string | null;
  statisticBasis?: string;
  dataTimestampMs: number | null;
  source: {
    provider: string;
    endpoint: string;
    mode: string;
    requestId: string | null;
    requestParams: Record<string, string>;
    rawResponseRef: string;
  };
}

export interface LeafEvidence {
  leafId: string;
  kind: string;
  truth: string;
  reasonCode: string;
  evidenceId: string;
  narrative: string;
  observations: Observation[];
  freshness: { ageMs: number | null; thresholdMs: number; fresh: boolean; note?: string };
  comparison?: { operator: string; lhs: string; rhs: string; unit: string; passed: boolean } | null;
  conflicts: any[];
}

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return body as T;
}

export const api = {
  health: () => j<any>('/api/health'),
  meta: () => j<any>('/api/meta'),
  catalog: () => j<{ instruments: any[] }>('/api/catalog'),

  tasks: () => j<{ tasks: TaskSummary[] }>('/api/tasks'),
  task: (id: string) => j<any>(`/api/tasks/${encodeURIComponent(id)}`),

  parse: (text: string) =>
    j<any>('/api/rules/parse', { method: 'POST', body: JSON.stringify({ text }) }),

  createTask: (body: { text: string; name?: string; schedule?: any; policy?: any }) =>
    j<any>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),

  updateRule: (id: string, body: { text?: string; root?: any; scope?: any }) =>
    j<any>(`/api/tasks/${encodeURIComponent(id)}/rule`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  run: (id: string) =>
    j<any>(`/api/tasks/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}' }),

  setState: (id: string, action: 'pause' | 'resume' | 'archive') =>
    j<any>(`/api/tasks/${encodeURIComponent(id)}/state`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  evidence: (id: string) => j<any>(`/api/evidence/${encodeURIComponent(id)}`),

  radar: () => j<any>('/api/radar'),

  chaos: () => j<any>('/api/chaos'),
  setChaos: (scenario: string | null, endpoints?: string[]) =>
    j<any>('/api/chaos', { method: 'POST', body: JSON.stringify({ scenario, endpoints }) }),

  complianceRejects: () => j<any>('/api/compliance/rejects'),
};

/** 状态徽章的显示映射 */
export const STATE_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '监控中',
  EVALUATING: '评估中',
  TRIGGERED: '已触发',
  COOLDOWN: '冷却中',
  DEGRADED: '降级',
  RECOVERING: '恢复中',
  PAUSED: '已暂停',
  FAILED: '失败',
  ARCHIVED: '已归档',
};

export const REASON_LABEL: Record<string, string> = {
  OK: '正常',
  STALE: '数据过期',
  CONFLICT: '源冲突',
  FAILURE: '接口失败',
  RATE_LIMITED: '限流',
  CAPABILITY_DENIED: '能力未开放',
  NOT_READY: '数据未就绪',
  UNSUPPORTED: '不支持',
  MALFORMED_ENVELOPE: '非标准响应',
  EMPTY_DATA: '无数据',
};

export const KIND_LABEL: Record<string, string> = {
  price: '价格',
  event: '事件',
  calendar: '日历',
  heat: '热度',
};

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '未知';
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${(ms / 3600_000).toFixed(1)} 小时`;
}
