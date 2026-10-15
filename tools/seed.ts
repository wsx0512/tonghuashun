/**
 * 演示种子数据。
 *
 * 造几条**能立刻看出效果**的监控任务：既有当前就命中的（用户一进来
 * 就能看到触发与证据链），也有当前未命中的（能演示"为什么没触发"），
 * 还有组合条件与只含日历条件的边界情况。
 *
 * 涉及持仓/关注池的均为**构造数据**，不含任何真实用户信息。
 *
 * 运行： npm run seed
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/server/store/db.js';
import * as repo from '../src/server/store/repo.js';
import { parseNaturalLanguage, type CatalogEntry } from '../src/server/nl/parser.js';
import { validateRule } from '../src/server/domain/validate.js';
import type { MonitorTask, RuleDocument, Schedule, TriggerPolicy } from '../src/shared/dsl/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const catalog: CatalogEntry[] = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'catalog.json'), 'utf8'),
).instruments;

interface SeedSpec {
  text: string;
  name?: string;
  schedule?: Schedule;
  policy?: Partial<TriggerPolicy>;
}

const SEEDS: SeedSpec[] = [
  {
    name: '茅台跌破与急涨',
    text: '贵州茅台跌破1200元 或者 涨幅超过5%',
    schedule: { kind: 'interval', everyMs: 30_000, tradingHoursOnly: false },
    policy: { triggerMode: 'level', cooldown: { kind: 'hours', value: 4 } },
  },
  {
    name: '崇达技术涨停监控',
    text: '崇达技术出现涨停',
    schedule: { kind: 'interval', everyMs: 30_000, tradingHoursOnly: false },
    policy: { triggerMode: 'level', cooldown: { kind: 'hours', value: 2 } },
  },
  {
    name: '华北制药热度异动',
    text: '华北制药进入热榜前5',
    schedule: { kind: 'interval', everyMs: 45_000, tradingHoursOnly: false },
    policy: { triggerMode: 'level', cooldown: { kind: 'hours', value: 6 } },
  },
  {
    name: '组合条件：茅台风险 + 崇达涨停',
    text: '（贵州茅台跌破1200元 或者 贵州茅台回撤超过10%）并且 崇达技术出现涨停',
    schedule: { kind: 'interval', everyMs: 60_000, tradingHoursOnly: false },
    policy: { triggerMode: 'level', cooldown: { kind: 'hours', value: 4 } },
  },
  {
    name: '宁德时代回撤跟踪',
    text: '宁德时代回撤超过15%',
    schedule: { kind: 'interval', everyMs: 60_000, tradingHoursOnly: true },
    policy: { triggerMode: 'edge', cooldown: { kind: 'hours', value: 8 } },
  },
  {
    name: '交易日历（每交易日提醒）',
    text: '贵州茅台每个交易日',
    schedule: { kind: 'dailyAt', times: ['09:35'], tradingDaysOnly: true },
    policy: { triggerMode: 'level', cooldown: { kind: 'trading_day', value: 1 } },
  },
];

function main() {
  const db = openDb();
  const now = Date.now();

  // 清空既有演示任务（保留表结构）
  for (const t of repo.listTasks(db, true)) {
    if (t.id.startsWith('seed_')) {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
      db.prepare('DELETE FROM rule_documents WHERE task_id = ?').run(t.id);
      db.prepare('DELETE FROM runs WHERE task_id = ?').run(t.id);
      db.prepare('DELETE FROM triggers WHERE task_id = ?').run(t.id);
      db.prepare('DELETE FROM notifications WHERE task_id = ?').run(t.id);
      db.prepare('DELETE FROM events WHERE task_id = ?').run(t.id);
      db.prepare('DELETE FROM evidence WHERE task_id = ?').run(t.id);
      db.prepare('DELETE FROM condition_runtime WHERE task_id = ?').run(t.id);
      db.prepare('DELETE FROM suppressed WHERE task_id = ?').run(t.id);
    }
  }

  let created = 0;
  SEEDS.forEach((spec, i) => {
    const parsed = parseNaturalLanguage(spec.text, catalog);
    if (!parsed.ok) {
      console.warn(`  ! 跳过「${spec.text}」：${parsed.message}`);
      return;
    }
    const report = validateRule(parsed.root, parsed.scope, catalog);
    if (report.errors.length > 0) {
      console.warn(`  ! 跳过「${spec.text}」：${report.errors.join('；')}`);
      return;
    }

    const id = `seed_${i + 1}`;
    const rule: RuleDocument = {
      id: `${id}_v1`,
      taskId: id,
      schemaVersion: '1.0.0',
      version: 1,
      createdAt: now,
      author: 'nl_parser',
      source: { kind: 'nl', rawText: spec.text, parseMeta: parsed.meta },
      scope: parsed.scope,
      root: parsed.root,
    };
    repo.insertRuleDocument(db, rule);

    const policy: TriggerPolicy = {
      triggerMode: spec.policy?.triggerMode ?? 'level',
      cooldown: spec.policy?.cooldown ?? { kind: 'hours', value: 4 },
      notifyOnRecovery: spec.policy?.notifyOnRecovery ?? true,
      maxConsecutiveFailures: spec.policy?.maxConsecutiveFailures ?? 3,
    };

    const task: MonitorTask = {
      id,
      name: spec.name ?? spec.text,
      activeRuleVersionId: rule.id,
      schedule: spec.schedule ?? { kind: 'interval', everyMs: 30_000, tradingHoursOnly: false },
      policy,
      state: 'PENDING',
      health: { consecutiveFailures: 0, lastEvaluatedAt: null, lastReasonCode: null, degradedSince: null },
      cooldownUntil: null,
      // 错开首次评估时间，避免所有任务在同一瞬间挤在一起
      nextRunAt: now + 3000 + i * 1200,
      createdAt: now,
      updatedAt: now,
    };
    repo.upsertTask(db, task);
    repo.logEvent(db, { taskId: id, kind: 'CREATED', payload: { seeded: true, rawText: spec.text }, now });
    if (report.warnings.length) {
      console.log(`  · ${spec.name}：${report.warnings.join('；')}`);
    }
    created++;
  });

  console.log(`[seed] 创建了 ${created} 个演示任务`);
  console.log('[seed] 说明：关注池与任务均为构造的演示数据，不含真实用户信息。');
  db.close();
}

main();
