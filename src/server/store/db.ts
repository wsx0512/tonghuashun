/**
 * 持久化层 —— Node 24 内置的 node:sqlite。
 *
 * 选型理由：零原生编译依赖（不像 better-sqlite3 需要 prebuild 或构建工具链），
 * 在 Windows + 无 docker 的环境下风险最低。且去重与调度幂等**必须**依赖
 * 数据库语义（UNIQUE 约束 + INSERT OR IGNORE 的原子性），JSON 文件做不到。
 *
 * 三张关键表承担核心不变量：
 *   triggers(dedup_key PK)      —— 跨重启的原子去重
 *   runs(task_id, slot_key UK)  —— 跨重启的调度幂等
 *   events                      —— 状态变迁的不可变日志
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  active_rule_version_id TEXT NOT NULL,
  schedule_json         TEXT NOT NULL,
  policy_json           TEXT NOT NULL,
  state                 TEXT NOT NULL,
  health_json           TEXT NOT NULL,
  cooldown_until        INTEGER,
  next_run_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_documents (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  version        INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  author         TEXT NOT NULL,
  source_json    TEXT NOT NULL,
  scope_json     TEXT NOT NULL,
  root_json      TEXT NOT NULL,
  diff_json      TEXT,
  UNIQUE(task_id, version)
);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  slot_key        TEXT NOT NULL,
  rule_version_id TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  status          TEXT NOT NULL,
  truth           TEXT,
  reason_code     TEXT,
  narrative       TEXT,
  backfilled      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(task_id, slot_key)
);

CREATE TABLE IF NOT EXISTS triggers (
  dedup_key       TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  leaf_id         TEXT NOT NULL,
  subject_thscode TEXT,
  bucket_key      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS suppressed (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  leaf_id       TEXT NOT NULL,
  dedup_key     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  run_id      TEXT,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  epistemic   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  run_id       TEXT,
  kind         TEXT NOT NULL,
  from_state   TEXT,
  to_state     TEXT,
  payload_json TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  rule_version_id TEXT NOT NULL,
  leaf_id         TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_responses (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  params_hash   TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  http_status   INTEGER NOT NULL,
  code          INTEGER,
  request_id    TEXT,
  body_json     TEXT NOT NULL,
  retrieved_at  INTEGER NOT NULL,
  mode          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS condition_runtime (
  task_id       TEXT NOT NULL,
  leaf_id       TEXT NOT NULL,
  last_true_at  INTEGER,
  last_false_at INTEGER,
  last_value    TEXT,
  PRIMARY KEY (task_id, leaf_id)
);

CREATE TABLE IF NOT EXISTS calendar (
  date    TEXT PRIMARY KEY,
  date_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS compliance_rejects (
  id          TEXT PRIMARY KEY,
  raw_text    TEXT NOT NULL,
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
CREATE INDEX IF NOT EXISTS idx_raw_endpoint ON raw_responses(endpoint, retrieved_at DESC);
`;

export interface DbOptions {
  /** ':memory:' 用于测试 */
  path?: string;
}

export function openDb(opts: DbOptions = {}): DatabaseSync {
  let dbPath = opts.path;
  if (!dbPath) {
    const dir = join(__dirname, '..', '..', '..', 'var');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    dbPath = join(dir, 'sentinel.db');
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** 生成短 id（确定性足够，无需加密强度） */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}${r}`;
}
