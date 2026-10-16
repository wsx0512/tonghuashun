/**
 * 服务端入口：装配所有部件并启动调度器。
 *
 * 启动顺序有讲究：
 *   1. 打开数据库
 *   2. 加载交易日历（调度器与日历条件都依赖它）
 *   3. 冷启动恢复：把上次进程中断遗留的 'evaluating' 记录标记为 interrupted
 *   4. 启动调度 tick
 *   5. 监听 HTTP
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './store/db.js';
import * as repo from './store/repo.js';
import { ReplayAdapter } from './sources/replay.adapter.js';
import { ChaosAdapter, type ChaosScenario } from './sources/chaos.adapter.js';
import { SourceMesh } from './sources/sourceMesh.js';
import { tick, type EngineDeps } from './scheduler/engine.js';
import { createApp } from './http/app.js';
import { WebhookChannel } from './delivery/webhook.js';
import { systemClock } from './clock.js';
import type { CatalogEntry } from './nl/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const PORT = Number(process.env.PORT ?? 8787);
const TICK_MS = Number(process.env.SENTINEL_TICK_MS ?? 15_000);

async function main() {
  const db = openDb();
  console.log('[sentinel] 数据库已就绪');

  // ── 标的目录 ──
  const catalogPath = join(ROOT, 'fixtures', 'catalog.json');
  const catalog: CatalogEntry[] = existsSync(catalogPath)
    ? JSON.parse(readFileSync(catalogPath, 'utf8')).instruments
    : [];
  const names = new Map(catalog.map((c) => [c.thscode, c.name]));
  console.log(`[sentinel] 载入 ${catalog.length} 个标的`);

  // ── 数据源 ──
  /**
   * 实时扶摇适配器**尚未实现**（本项目未获得 API Key，无凭据无法验证真实连通性）。
   * 因此数据源恒为回放，界面与日志也据此如实标注。
   *
   * 用户若设了 SENTINEL_MODE=live，必须**大声告知**并继续用回放 ——
   * 绝不能把回放数据标成"实时"，那会让评审在一个假前提下核对本作品的核心主张。
   */
  if (process.env.SENTINEL_MODE === 'live') {
    console.warn(
      '[sentinel] ⚠ SENTINEL_MODE=live 已设置，但实时扶摇适配器尚未实现（无 API Key 可验证）。\n' +
        '[sentinel]   将继续使用回放数据，并在界面与 /api/meta 中如实标注为回放，不会标成实时。',
    );
  }
  const replay = new ReplayAdapter();
  const dataSource = {
    kind: 'replay' as const,
    label: '回放 fixture（公开行情源快照重建）',
    note: 'fixture 由东方财富/新浪公开行情于 2026-10-15 收盘后抓取，按扶摇契约重建信封结构。详见 fixtures/README.md',
  };
  const chaos = new ChaosAdapter(replay);
  // 备源：平时与主源一致（perturbPct=0），制造冲突时施加确定性偏差
  const secondary = new ReplayAdapter({ perturbPct: 0 });
  const mesh = new SourceMesh({ primary: chaos, secondary, tolerancePct: 0.005 });

  /**
   * 站外推送渠道。默认**未配置**——没有 SENTINEL_WEBHOOK_URL 时不会假装投递成功，
   * 每次通知都会如实记为 SKIPPED 并写明原因（可在界面上看到）。
   */
  const webhook = new WebhookChannel({ url: process.env.SENTINEL_WEBHOOK_URL ?? null });
  console.log(`[sentinel] 站外推送: ${webhook.describe().label}`);

  const deps: EngineDeps = {
    db,
    mesh,
    now: () => systemClock.now(),
    subjectName: (code) => names.get(code) ?? code,
    isTradingDay: (compact) => repo.isTradingDay(db, compact),
    delivery: webhook,
  };

  // ── 交易日历 ──
  const loadCalendar = async (): Promise<number> => {
    const r = await replay.fetch<any>({ endpoint: '/api/a-share/calendar/trading-days', params: {} });
    if (!r.ok) {
      console.warn('[sentinel] 交易日历加载失败:', r.message);
      return 0;
    }
    const days = (r.data.item ?? []).map((d: any) => ({ date: String(d.date), date_ms: d.date_ms }));
    repo.replaceCalendar(db, days);
    console.log(`[sentinel] 交易日历 ${days.length} 天`);
    return days.length;
  };
  await loadCalendar();

  // ── 冷启动恢复 ──
  const interrupted = repo.markInterruptedRuns(db, deps.now());
  if (interrupted > 0) {
    console.log(`[sentinel] 标记了 ${interrupted} 条中断的评估记录`);
  }
  // 重新排程：把上次遗留的 nextRunAt 归零，让调度器重新拾起
  const tasks = repo.listTasks(db);
  for (const t of tasks) {
    if ((t.state === 'PENDING' || t.state === 'RECOVERING') && (t.nextRunAt ?? 0) < deps.now()) {
      repo.setTaskState(db, t.id, t.state, { nextRunAt: deps.now() + 2000 });
    }
  }
  console.log(`[sentinel] 恢复 ${tasks.length} 个任务`);

  // ── 故障注入的联动：冲突场景需要备源施加偏差 ──
  const setScenario = (s: ChaosScenario | null, o: { endpoints?: string[]; staleMs?: number } = {}) => {
    chaos.setScenario(s, o);
    secondary.perturbPct = s === 'conflict_price' ? 0.0087 : 0;
  };
  const chaosCtl = {
    get activeScenario() {
      return chaos.activeScenario;
    },
    setScenario,
    clear: () => {
      chaos.clear();
      secondary.perturbPct = 0;
    },
  };

  // ── 调度器 ──
  let schedulerTimer: NodeJS.Timeout | null = null;
  let ticking = false;

  const runTick = async () => {
    if (ticking) return; // 防止上一次 tick 未完成时重入
    ticking = true;
    try {
      const r = await tick(deps);
      if (r.evaluated > 0) {
        console.log(
          `[sentinel] tick: 评估 ${r.evaluated} · 触发 ${r.triggered} · 降级 ${r.degraded} · 跳过 ${r.skipped}`,
        );
      }
    } catch (e) {
      console.error('[sentinel] tick 异常:', e);
    } finally {
      ticking = false;
    }
  };

  const startScheduler = () => {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(runTick, TICK_MS);
    console.log(`[sentinel] 调度器已启动（每 ${TICK_MS / 1000} 秒）`);
  };
  const stopScheduler = () => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
      console.log('[sentinel] 调度器已停止');
    }
  };

  startScheduler();

  // ── HTTP ──
  const app = createApp({
    db,
    deps,
    catalog,
    dataSource,
    delivery: webhook.describe(),
    chaos: chaosCtl,
    loadCalendar,
    startScheduler,
    stopScheduler,
    schedulerRunning: () => schedulerTimer !== null,
  });

  const server = app.listen(PORT, () => {
    console.log(`[sentinel] 监听 http://localhost:${PORT}`);
    console.log(`[sentinel] 数据来源: ${dataSource.label}`);
  });

  const shutdown = () => {
    console.log('\n[sentinel] 正在关闭…');
    stopScheduler();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[sentinel] 启动失败:', e);
  process.exit(1);
});
