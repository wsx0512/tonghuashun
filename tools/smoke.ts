/**
 * 端到端冒烟测试 —— 对着**正在运行的服务**跑完整主链路。
 *
 * 与单元测试的分工：单元测试验证各模块的确定性行为；
 * 这个脚本验证「装配起来之后真的能用」，并且**顺便充当演示脚本**——
 * 每完成一项就打印出用户实际会看到的中文文案。
 *
 * 用法：
 *   终端 A: npm run seed && npm run start
 *   终端 B: npm run smoke
 */

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8787';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, detail = '') {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
function bad(name: string, why: string) {
  failed++;
  failures.push(`${name}: ${why}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${why}\x1b[0m`);
}
function section(t: string) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

async function req<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });
  return (await res.json()) as T;
}

const post = (p: string, body?: any) =>
  req(p, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body) });

async function main() {
  console.log(`\x1b[1m哨兵 Sentinel · 端到端冒烟测试\x1b[0m  (${BASE})`);

  // ─────────────────────────────────────────────
  section('① 服务健康');
  const health = await req('/api/health');
  health.ok ? ok('服务可访问', `模式=${health.mode}`) : bad('服务可访问', '返回 ok=false');
  health.calendarDays > 0
    ? ok('交易日历已加载', `${health.calendarDays} 天`)
    : bad('交易日历已加载', '日历为空，调度器无法判断交易日');

  const meta = await req('/api/meta');
  /回放|实时/.test(meta.dataSource ?? '')
    ? ok('数据来源已如实标注', meta.dataSource)
    : bad('数据来源已如实标注', '未标注来源');

  /**
   * 反「假装实时」回归。实时扶摇适配器并未实现，所以数据来源恒为回放；
   * 一旦有人设了 SENTINEL_MODE=live 就想让界面显示"实时"，这里会拦下。
   * 关键在于**两个接口必须互相自洽** —— 不能一个说 live 一个说 replay。
   */
  health.mode === 'replay'
    ? ok('数据来源与实际适配器一致', `mode=${health.mode}`)
    : bad('数据来源与实际适配器一致', `health.mode=${health.mode}，但项目中并无实时适配器实现`);
  meta.dataSource === health.mode || meta.dataSource.includes('回放')
    ? ok('两个接口来源口径自洽', `${health.mode} ↔ ${meta.dataSource}`)
    : bad('两个接口来源口径自洽', `health.mode=${health.mode} 与 meta.dataSource=${meta.dataSource} 矛盾`);

  // ─────────────────────────────────────────────
  section('② 自然语言 → 可检查的规则');
  const p1 = await post('/api/rules/parse', { text: '贵州茅台跌破1200元 或者 涨幅超过5%' });
  p1.ok
    ? ok('解析组合条件', p1.summary)
    : bad('解析组合条件', p1.message);

  const p2 = await post('/api/rules/parse', { text: '（贵州茅台跌破1200元 或者 回撤超过10%）并且 崇达技术出现涨停' });
  p2.ok && p2.root?.type === 'and'
    ? ok('括号优先级的组合条件', '解析为 AND(OR(...), ...)')
    : bad('括号优先级的组合条件', JSON.stringify(p2.root?.type));

  // ─────────────────────────────────────────────
  section('③ 合规边界：预测与建议类意图必须被拒绝');
  for (const t of ['茅台会涨吗', '什么时候买入宁德时代', '给我推荐一只股票']) {
    const r = await post('/api/rules/parse', { text: t });
    if (!r.ok && r.kind === 'compliance') ok(`拒绝「${t}」`, r.complianceLabel);
    else bad(`拒绝「${t}」`, `实际返回 ok=${r.ok} kind=${r.kind}`);
  }

  section('④ 能力边界：做不到的如实说，不猜');
  const subj = await post('/api/rules/parse', { text: '贵州茅台走势健康' });
  !subj.ok && /主观/.test(subj.message ?? '')
    ? ok('主观描述被明确拒绝', '并给出可替代的说法')
    : bad('主观描述被明确拒绝', JSON.stringify(subj).slice(0, 120));

  // ─────────────────────────────────────────────
  section('⑤ 主链路：创建任务并触发');
  await post('/api/chaos', { scenario: null }); // 确保干净起点
  const created = await post('/api/tasks', {
    text: '崇达技术出现涨停',
    name: `冒烟测试-${Date.now().toString(36)}`,
  });
  if (!created.ok) {
    bad('创建任务', created.message);
    return finish();
  }
  ok('创建任务', created.task.id);

  const run1 = await post(`/api/tasks/${created.task.id}/run`);
  const r1 = run1.result;
  r1.truth === true
    ? ok('条件命中并触发', `状态 ${r1.stateBefore} → ${r1.stateAfter}，通知 ${r1.notifications.length} 条`)
    : bad('条件命中并触发', `truth=${r1.truth}`);

  const leaf = r1.leaves?.[0];
  if (leaf) {
    const o = leaf.observations?.[0];
    const five = {
      来源: !!o?.source?.endpoint,
      时点: !!o?.dataTimestampMs,
      单位: o?.unit !== undefined,
      口径: !!o?.statisticBasis,
      原始响应: !!o?.source?.rawResponseRef,
      request_id: !!o?.source?.requestId,
    };
    const missing = Object.entries(five).filter(([, v]) => !v).map(([k]) => k);
    missing.length === 0
      ? ok('证据链要素齐全', '来源/时点/单位/口径/原始响应/request_id')
      : bad('证据链要素齐全', `缺失 ${missing.join('、')}`);
  }

  // ─────────────────────────────────────────────
  section('⑥ 降级：数据过期时必须说"无法判定"，而不是"未触发"');
  const staleTask = await post('/api/tasks', { text: '贵州茅台跌破1200元', name: `冒烟-过期-${Date.now().toString(36)}` });
  if (staleTask.ok) {
    await post('/api/chaos', { scenario: 'stale_price' });
    const rs = (await post(`/api/tasks/${staleTask.task.id}/run`)).result;
    if (rs.truth === 'unknown' && rs.reasonCode === 'STALE') {
      ok('过期数据判为无法判定', `${rs.stateBefore} → ${rs.stateAfter}`);
      console.log(`      \x1b[2m${rs.leaves[0]?.narrative}\x1b[0m`);
      rs.notifications.filter((n: any) => n.kind === 'TRIGGERED').length === 0
        ? ok('降级时不产生触发通知')
        : bad('降级时不产生触发通知', '降级状态下仍发出了触发通知');
    } else {
      bad('过期数据判为无法判定', `truth=${rs.truth} reason=${rs.reasonCode}`);
    }

    section('⑦ 恢复：数据回来后发恢复通知');
    await post('/api/chaos', { scenario: null });
    const rr = (await post(`/api/tasks/${staleTask.task.id}/run`)).result;
    rr.truth !== 'unknown'
      ? ok('恢复正常后可判定', `truth=${rr.truth}`)
      : bad('恢复正常后可判定', `仍为 ${rr.reasonCode}`);
    rr.notifications.some((n: any) => n.kind === 'HEALTH_RECOVERED')
      ? ok('发出健康恢复通知', rr.notifications.find((n: any) => n.kind === 'HEALTH_RECOVERED').text)
      : bad('发出健康恢复通知', '未收到恢复通知');
  }

  // ─────────────────────────────────────────────
  section('⑧ 源冲突：两个取值并列展示，不静默二选一');
  const cfTask = await post('/api/tasks', { text: '贵州茅台跌破1200元', name: `冒烟-冲突-${Date.now().toString(36)}` });
  if (cfTask.ok) {
    await post('/api/chaos', { scenario: 'conflict_price' });
    const rc = (await post(`/api/tasks/${cfTask.task.id}/run`)).result;
    if (rc.reasonCode === 'CONFLICT') {
      const c = rc.leaves[0]?.conflicts?.[0];
      c
        ? ok('检出冲突且两个值都保留', `${c.sourceA}=${c.valueA} vs ${c.sourceB}=${c.valueB}，差 ${(c.deltaPct * 100).toFixed(2)}%`)
        : bad('检出冲突且两个值都保留', 'conflicts 为空');
      rc.truth === 'unknown'
        ? ok('冲突时不给肯定结论', '判为无法判定')
        : bad('冲突时不给肯定结论', `却给出了 truth=${rc.truth} 的肯定结论`);
    } else {
      bad('检出冲突', `reasonCode=${rc.reasonCode}`);
    }
    await post('/api/chaos', { scenario: null });
  }

  // ─────────────────────────────────────────────
  section('⑨ 接口失败与未开放能力');
  for (const [scenario, expect] of [
    ['upstream_failure', 'FAILURE'],
    ['rate_limited', 'RATE_LIMITED'],
    ['not_ready', 'NOT_READY'],
    ['capability_denied', 'CAPABILITY_DENIED'],
    ['malformed', 'MALFORMED_ENVELOPE'],
  ] as const) {
    const t = await post('/api/tasks', { text: '贵州茅台跌破1200元', name: `冒烟-${scenario}` });
    if (!t.ok) continue;
    await post('/api/chaos', { scenario });
    const r = (await post(`/api/tasks/${t.task.id}/run`)).result;
    r.reasonCode === expect && r.truth === 'unknown'
      ? ok(`${scenario} → ${expect}`)
      : bad(`${scenario} → ${expect}`, `实际 ${r.truth}/${r.reasonCode}`);
  }
  await post('/api/chaos', { scenario: null });

  // ─────────────────────────────────────────────
  section('⑩ 去重与冷却');
  const dd = await post('/api/tasks', {
    text: '崇达技术出现涨停',
    name: `冒烟-去重-${Date.now().toString(36)}`,
    policy: { cooldown: { kind: 'trading_day', value: 1 } },
  });
  if (dd.ok) {
    const a = (await post(`/api/tasks/${dd.task.id}/run`)).result;
    const t1 = a.notifications.filter((n: any) => n.kind === 'TRIGGERED').length;
    // 强制再评估一次（绕开调度幂等），验证去重
    const b = (await post(`/api/tasks/${dd.task.id}/run`)).result;
    const t2 = b.notifications.filter((n: any) => n.kind === 'TRIGGERED').length;
    t1 === 1 && t2 === 0 && b.suppressedCount > 0
      ? ok('同桶内重复触发被去重', `首次 ${t1} 条，再次 ${t2} 条，抑制 ${b.suppressedCount} 次`)
      : bad('同桶内重复触发被去重', `t1=${t1} t2=${t2} suppressed=${b.suppressedCount}`);

    const detail = await req(`/api/tasks/${dd.task.id}`);
    detail.suppressed?.length > 0
      ? ok('抑制被留痕（可见，非静默丢弃）', detail.suppressed[0].reason)
      : bad('抑制被留痕', '无抑制记录');
  }

  // ─────────────────────────────────────────────
  section('⑪ 规则版本留存');
  const vTask = await post('/api/tasks', { text: '贵州茅台跌破1200元', name: `冒烟-版本-${Date.now().toString(36)}` });
  if (vTask.ok) {
    const up = await req(`/api/tasks/${vTask.task.id}/rule`, {
      method: 'PUT',
      body: JSON.stringify({ text: '贵州茅台跌破1300元' }),
    });
    up.ok && up.rule.version === 2
      ? ok('修改规则生成新版本', `v1 → v${up.rule.version}`)
      : bad('修改规则生成新版本', JSON.stringify(up).slice(0, 120));
    const detail = await req(`/api/tasks/${vTask.task.id}`);
    detail.ruleHistory?.length === 2
      ? ok('历史版本保留', detail.ruleHistory.map((r: any) => `v${r.version}`).join(', '))
      : bad('历史版本保留', `只有 ${detail.ruleHistory?.length} 个版本`);
  }

  // ─────────────────────────────────────────────
  section('⑫ 风险雷达');
  const radar = await req('/api/radar');
  radar.ok && Array.isArray(radar.rows)
    ? ok('雷达聚合可用', `任务 ${radar.summary.total} · 触发 ${radar.summary.triggered7d} · 降级 ${radar.summary.degraded}`)
    : bad('雷达聚合可用', JSON.stringify(radar).slice(0, 120));

  finish();
}

function finish() {
  console.log(
    `\n\x1b[1m结果\x1b[0m: \x1b[32m${passed} 通过\x1b[0m${
      failed ? `，\x1b[31m${failed} 失败\x1b[0m` : '，0 失败'
    }`,
  );
  if (failures.length) {
    console.log('\n\x1b[31m失败明细:\x1b[0m');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n\x1b[31m冒烟测试异常终止:\x1b[0m', e);
  console.error('请确认服务已启动： npm run seed && npm run start');
  process.exit(1);
});
