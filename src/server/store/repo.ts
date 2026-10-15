/**
 * 仓储层：把数据库语义封装成有类型的操作。
 *
 * 两个必须用数据库而非内存实现的不变量：
 *   1. **去重**：triggers.dedup_key 是主键，配合 INSERT OR IGNORE，
 *      即使进程重启、并发 tick，同一 bucket 内也只会触发一次。
 *   2. **调度幂等**：runs(task_id, slot_key) 唯一，避免 tick 抖动导致重复评估。
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  Condition,
  MonitorTask,
  RuleDocument,
  Schedule,
  TaskState,
  TriggerPolicy,
  TaskHealth,
  ReasonCode,
  Truth,
} from '../../shared/dsl/types.js';
import { newId } from './db.js';

// ────────────────────────── 任务 ──────────────────────────

export function upsertTask(db: DatabaseSync, t: MonitorTask): void {
  db.prepare(
    `INSERT INTO tasks (id,name,active_rule_version_id,schedule_json,policy_json,state,health_json,
       cooldown_until,next_run_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       active_rule_version_id=excluded.active_rule_version_id,
       schedule_json=excluded.schedule_json,
       policy_json=excluded.policy_json,
       state=excluded.state,
       health_json=excluded.health_json,
       cooldown_until=excluded.cooldown_until,
       next_run_at=excluded.next_run_at,
       updated_at=excluded.updated_at`,
  ).run(
    t.id,
    t.name,
    t.activeRuleVersionId,
    JSON.stringify(t.schedule),
    JSON.stringify(t.policy),
    t.state,
    JSON.stringify(t.health),
    t.cooldownUntil ?? null,
    t.nextRunAt ?? null,
    t.createdAt,
    t.updatedAt,
  );
}

function rowToTask(r: any): MonitorTask {
  return {
    id: r.id,
    name: r.name,
    activeRuleVersionId: r.active_rule_version_id,
    schedule: JSON.parse(r.schedule_json) as Schedule,
    policy: JSON.parse(r.policy_json) as TriggerPolicy,
    state: r.state as TaskState,
    health: JSON.parse(r.health_json) as TaskHealth,
    cooldownUntil: r.cooldown_until ?? null,
    nextRunAt: r.next_run_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTask(db: DatabaseSync, id: string): MonitorTask | null {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return r ? rowToTask(r) : null;
}

export function listTasks(db: DatabaseSync, includeArchived = false): MonitorTask[] {
  const sql = includeArchived
    ? 'SELECT * FROM tasks ORDER BY created_at DESC'
    : "SELECT * FROM tasks WHERE state != 'ARCHIVED' ORDER BY created_at DESC";
  return db.prepare(sql).all().map(rowToTask);
}

/** 所有到期待评估的任务 */
export function dueTasks(db: DatabaseSync, now: number): MonitorTask[] {
  return db
    .prepare(
      `SELECT * FROM tasks
       WHERE state IN ('PENDING','RECOVERING')
         AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    )
    .all(now)
    .map(rowToTask);
}

export function setTaskState(
  db: DatabaseSync,
  id: string,
  state: TaskState,
  patch: Partial<Pick<MonitorTask, 'cooldownUntil' | 'nextRunAt' | 'health'>> = {},
): void {
  const cur = getTask(db, id);
  if (!cur) return;
  upsertTask(db, {
    ...cur,
    state,
    cooldownUntil: patch.cooldownUntil !== undefined ? patch.cooldownUntil : cur.cooldownUntil,
    nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : cur.nextRunAt,
    health: patch.health ?? cur.health,
    updatedAt: Date.now(),
  });
}

// ────────────────────────── 规则版本 ──────────────────────────

export function insertRuleDocument(db: DatabaseSync, doc: RuleDocument, diff?: unknown): void {
  db.prepare(
    `INSERT INTO rule_documents (id,task_id,version,schema_version,created_at,author,source_json,scope_json,root_json,diff_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    doc.id,
    doc.taskId,
    doc.version,
    doc.schemaVersion,
    doc.createdAt,
    doc.author,
    JSON.stringify(doc.source),
    JSON.stringify(doc.scope),
    JSON.stringify(doc.root),
    diff ? JSON.stringify(diff) : null,
  );
}

function rowToRule(r: any): RuleDocument {
  return {
    id: r.id,
    taskId: r.task_id,
    schemaVersion: r.schema_version,
    version: r.version,
    createdAt: r.created_at,
    author: r.author,
    source: JSON.parse(r.source_json),
    scope: JSON.parse(r.scope_json),
    root: JSON.parse(r.root_json) as Condition,
  };
}

export function getRuleDocument(db: DatabaseSync, id: string): RuleDocument | null {
  const r = db.prepare('SELECT * FROM rule_documents WHERE id = ?').get(id);
  return r ? rowToRule(r) : null;
}

export function listRuleDocuments(db: DatabaseSync, taskId: string): RuleDocument[] {
  return db
    .prepare('SELECT * FROM rule_documents WHERE task_id = ? ORDER BY version ASC')
    .all(taskId)
    .map(rowToRule);
}

export function nextRuleVersion(db: DatabaseSync, taskId: string): number {
  const r = db
    .prepare('SELECT COALESCE(MAX(version),0) AS v FROM rule_documents WHERE task_id = ?')
    .get(taskId) as any;
  return Number(r?.v ?? 0) + 1;
}

// ────────────────────────── 调度幂等 ──────────────────────────

/**
 * 抢占一个评估槽位。返回 true 表示抢到（应该执行），
 * false 表示该槽位已被评估过（跳过）。
 *
 * 依赖 runs(task_id, slot_key) 的 UNIQUE 约束 —— 这是跨进程重启
 * 也能保证"同一时间槽只评估一次"的关键。
 */
export function claimSlot(
  db: DatabaseSync,
  taskId: string,
  slotKey: string,
  ruleVersionId: string,
  startedAt: number,
  backfilled = false,
): string | null {
  const id = newId('run');
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO runs (id,task_id,slot_key,rule_version_id,started_at,status,backfilled)
       VALUES (?,?,?,?,?,'evaluating',?)`,
    )
    .run(id, taskId, slotKey, ruleVersionId, startedAt, backfilled ? 1 : 0);
  return info.changes > 0 ? id : null;
}

export function finishRun(
  db: DatabaseSync,
  runId: string,
  patch: { status: string; truth?: Truth; reasonCode?: ReasonCode; narrative?: string; finishedAt: number },
): void {
  db.prepare(
    `UPDATE runs SET status=?, truth=?, reason_code=?, narrative=?, finished_at=? WHERE id=?`,
  ).run(
    patch.status,
    patch.truth === undefined ? null : String(patch.truth),
    patch.reasonCode ?? null,
    patch.narrative ?? null,
    patch.finishedAt,
    runId,
  );
}

/** 冷启动恢复：把中断的 run 标记为 interrupted */
export function markInterruptedRuns(db: DatabaseSync, now: number): number {
  const info = db
    .prepare(`UPDATE runs SET status='interrupted', finished_at=? WHERE status='evaluating'`)
    .run(now);
  return Number(info.changes ?? 0);
}

export function recentRuns(db: DatabaseSync, taskId: string, limit = 20): any[] {
  return db
    .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(taskId, limit);
}

// ────────────────────────── 去重与冷却 ──────────────────────────

/**
 * 抢占一个触发点。返回 true 表示本次应发通知；false 表示去重命中（已抑制）。
 * 依赖 triggers.dedup_key 主键 + INSERT OR IGNORE。
 */
export function claimTrigger(
  db: DatabaseSync,
  args: {
    dedupKey: string;
    taskId: string;
    runId: string;
    leafId: string;
    subjectThscode?: string;
    bucketKey: string;
    now: number;
  },
): boolean {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO triggers (dedup_key,task_id,run_id,leaf_id,subject_thscode,bucket_key,created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      args.dedupKey,
      args.taskId,
      args.runId,
      args.leafId,
      args.subjectThscode ?? null,
      args.bucketKey,
      args.now,
    );
  return Number(info.changes ?? 0) > 0;
}

/** 记录被抑制的触发 —— 用户能看到"冷却期内本会触发 N 次"，而不是静默丢弃 */
export function recordSuppressed(
  db: DatabaseSync,
  args: { taskId: string; leafId: string; dedupKey: string; reason: string; now: number },
): void {
  db.prepare(
    `INSERT INTO suppressed (id,task_id,leaf_id,dedup_key,reason,created_at) VALUES (?,?,?,?,?,?)`,
  ).run(newId('sup'), args.taskId, args.leafId, args.dedupKey, args.reason, args.now);
}

export function countSuppressed(db: DatabaseSync, taskId: string, sinceMs: number): number {
  const r = db
    .prepare('SELECT COUNT(*) AS c FROM suppressed WHERE task_id = ? AND created_at >= ?')
    .get(taskId, sinceMs) as any;
  return Number(r?.c ?? 0);
}

export function listSuppressed(db: DatabaseSync, taskId: string, limit = 50): any[] {
  return db
    .prepare('SELECT * FROM suppressed WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(taskId, limit);
}

// ────────────────────────── 条件运行时状态 ──────────────────────────

export function getConditionRuntime(db: DatabaseSync, taskId: string, leafId: string): any | null {
  return db
    .prepare('SELECT * FROM condition_runtime WHERE task_id = ? AND leaf_id = ?')
    .get(taskId, leafId) ?? null;
}

export function upsertConditionRuntime(
  db: DatabaseSync,
  args: {
    taskId: string;
    leafId: string;
    truth: Truth;
    now: number;
  },
): void {
  const prev = getConditionRuntime(db, args.taskId, args.leafId);
  const lastTrueAt = args.truth === true ? args.now : (prev?.last_true_at ?? null);
  const lastFalseAt = args.truth === false ? args.now : (prev?.last_false_at ?? null);
  db.prepare(
    `INSERT INTO condition_runtime (task_id,leaf_id,last_true_at,last_false_at,last_value)
     VALUES (?,?,?,?,?)
     ON CONFLICT(task_id,leaf_id) DO UPDATE SET
       last_true_at=excluded.last_true_at,
       last_false_at=excluded.last_false_at,
       last_value=excluded.last_value`,
  ).run(args.taskId, args.leafId, lastTrueAt, lastFalseAt, String(args.truth));
}

// ────────────────────────── 通知与事件 ──────────────────────────

export function addNotification(
  db: DatabaseSync,
  n: { taskId: string; runId?: string; kind: string; text: string; epistemic: 'fact' | 'inference' | 'unknown'; now: number },
): string {
  const id = newId('ntf');
  db.prepare(
    `INSERT INTO notifications (id,task_id,run_id,kind,text,epistemic,created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, n.taskId, n.runId ?? null, n.kind, n.text, n.epistemic, n.now);
  return id;
}

export function listNotifications(db: DatabaseSync, taskId: string, limit = 50): any[] {
  return db
    .prepare('SELECT * FROM notifications WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(taskId, limit);
}

export function logEvent(
  db: DatabaseSync,
  e: { taskId: string; runId?: string; kind: string; from?: TaskState; to?: TaskState; payload?: unknown; now: number },
): void {
  db.prepare(
    `INSERT INTO events (id,task_id,run_id,kind,from_state,to_state,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    newId('evt'),
    e.taskId,
    e.runId ?? null,
    e.kind,
    e.from ?? null,
    e.to ?? null,
    e.payload ? JSON.stringify(e.payload) : null,
    e.now,
  );
}

export function listEvents(db: DatabaseSync, taskId: string, limit = 100): any[] {
  return db
    .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(taskId, limit);
}

// ────────────────────────── 证据与原始响应 ──────────────────────────

export function saveEvidence(
  db: DatabaseSync,
  e: { id: string; taskId: string; runId: string; ruleVersionId: string; leafId: string; payload: unknown; now: number },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO evidence (id,task_id,run_id,rule_version_id,leaf_id,payload_json,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(e.id, e.taskId, e.runId, e.ruleVersionId, e.leafId, JSON.stringify(e.payload), e.now);
}

export function getEvidence(db: DatabaseSync, id: string): any | null {
  const r = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as any;
  return r ? { ...r, payload: JSON.parse(r.payload_json) } : null;
}

export function listEvidenceByRun(db: DatabaseSync, runId: string): any[] {
  return db
    .prepare('SELECT * FROM evidence WHERE run_id = ?')
    .all(runId)
    .map((r: any) => ({ ...r, payload: JSON.parse(r.payload_json) }));
}

export function saveRawResponse(
  db: DatabaseSync,
  r: {
    id: string; provider: string; endpoint: string; params: Record<string, string>;
    httpStatus: number; code: number | null; requestId: string | null;
    body: unknown; retrievedAt: number; mode: string;
  },
): void {
  const paramsJson = JSON.stringify(r.params);
  // 原始响应可能很大，截断到 200KB 以内，避免数据库膨胀
  const bodyJson = JSON.stringify(r.body);
  const truncated = bodyJson.length > 200_000 ? bodyJson.slice(0, 200_000) + '…[truncated]' : bodyJson;
  db.prepare(
    `INSERT OR REPLACE INTO raw_responses
       (id,provider,endpoint,params_hash,params_json,http_status,code,request_id,body_json,retrieved_at,mode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.id, r.provider, r.endpoint, hash(paramsJson), paramsJson,
    r.httpStatus, r.code, r.requestId, truncated, r.retrievedAt, r.mode,
  );
}

export function getRawResponse(db: DatabaseSync, id: string): any | null {
  const r = db.prepare('SELECT * FROM raw_responses WHERE id = ?').get(id) as any;
  if (!r) return null;
  return { ...r, params: JSON.parse(r.params_json), body: safeParse(r.body_json) };
}

// ────────────────────────── 交易日历 ──────────────────────────

export function replaceCalendar(db: DatabaseSync, days: { date: string; date_ms: number }[]): void {
  db.exec('DELETE FROM calendar');
  const stmt = db.prepare('INSERT OR REPLACE INTO calendar (date, date_ms) VALUES (?,?)');
  for (const d of days) stmt.run(d.date, d.date_ms);
}

export function isTradingDay(db: DatabaseSync, dateCompact: string): boolean | null {
  const r = db.prepare('SELECT 1 AS x FROM calendar WHERE date = ?').get(dateCompact);
  if (r) return true;
   const any = db.prepare('SELECT COUNT(*) AS c FROM calendar').get() as any;
  if (Number(any?.c ?? 0) === 0) return null; // 日历尚未加载 → 未知，不能当成"非交易日"
  return false;
}

export function calendarCount(db: DatabaseSync): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM calendar').get() as any;
  return Number(r?.c ?? 0);
}

// ────────────────────────── 合规留痕 ──────────────────────────

export function recordComplianceReject(
  db: DatabaseSync,
  args: { rawText: string; label: string; now: number },
): void {
  db.prepare(
    'INSERT INTO compliance_rejects (id,raw_text,label,created_at) VALUES (?,?,?,?)',
  ).run(newId('cpr'), args.rawText, args.label, args.now);
}

export function listComplianceRejects(db: DatabaseSync, limit = 50): any[] {
  return db.prepare('SELECT * FROM compliance_rejects ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ────────────────────────── app 状态（chaos 等）──────────────────────────

export function getAppState(db: DatabaseSync, key: string): any | null {
  const r = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as any;
  return r ? safeParse(r.value) : null;
}

export function setAppState(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare('INSERT OR REPLACE INTO app_state (key,value) VALUES (?,?)').run(key, JSON.stringify(value));
}

// ────────────────────────── 工具 ──────────────────────────

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
