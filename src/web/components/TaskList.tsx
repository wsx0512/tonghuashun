import { api, STATE_LABEL, REASON_LABEL, fmtTime } from '../api.js';

/**
 * 任务列表。每个任务卡片一眼可读：现在什么状态、为什么是这个状态、
 * 下次什么时候评估、规则文本是什么。
 */
export default function TaskList({
  tasks,
  selected,
  onSelect,
  onChanged,
  notify,
}: {
  tasks: any[];
  selected: string | null;
  onSelect: (id: string) => void;
  onChanged: () => void;
  notify: (kind: string, text: string) => void;
}) {
  if (tasks.length === 0) {
    return (
      <div className="panel">
        <div className="empty">还没有监控任务。在上面输入一句话开始，或先运行 <code className="mono">npm run seed</code> 载入演示任务。</div>
      </div>
    );
  }

  const runNow = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const r = await api.run(id);
    const res = r?.result;
    if (!res) return;
    const parts: string[] = [];
    if (res.skipped) parts.push(`跳过：${res.skipReason}`);
    else {
      parts.push(
        res.truth === 'unknown'
          ? `无法判定（${REASON_LABEL[res.reasonCode] ?? res.reasonCode}）`
          : res.truth
            ? '条件命中'
            : '条件未满足',
      );
      if (res.notifications?.length) parts.push(`发出 ${res.notifications.length} 条通知`);
      if (res.suppressedCount) parts.push(`抑制 ${res.suppressedCount} 次`);
    }
    parts.push(`${res.stateBefore} → ${res.stateAfter}`);
    notify(res.truth === 'unknown' ? 'warn' : 'info', parts.join('；'));
    onChanged();
  };

  const toggle = async (e: React.MouseEvent, t: any) => {
    e.stopPropagation();
    await api.setState(t.id, t.state === 'PAUSED' ? 'resume' : 'pause');
    notify('info', t.state === 'PAUSED' ? '已恢复监控' : '已暂停监控');
    onChanged();
  };

  return (
    <div>
      {tasks.map((t) => (
        <div key={t.id} className="task">
          <div className="task-head" onClick={() => onSelect(t.id)}>
            <span className={`pill ${t.state}`}>{STATE_LABEL[t.state] ?? t.state}</span>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="task-name">{t.name}</div>
              <div className="task-rule">{t.summary ?? '—'}</div>
            </div>

            <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <div className="tiny faint">
                规则 v{t.ruleVersion} · 下次 {fmtTime(t.nextRunAt)}
              </div>
              <div className="tiny faint">
                {t.reasonCode && t.reasonCode !== 'OK' && (
                  <span style={{ color: 'var(--warn)' }}>{REASON_LABEL[t.reasonCode] ?? t.reasonCode} · </span>
                )}
                {t.suppressedCount > 0 && <>24h 内抑制 {t.suppressedCount} 次 · </>}
                点击展开
              </div>
            </div>

            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm" onClick={(e) => runNow(e, t.id)}>
                立即评估
              </button>
              <button className="btn sm ghost" onClick={(e) => toggle(e, t)}>
                {t.state === 'PAUSED' ? '恢复' : '暂停'}
              </button>
            </div>
          </div>

          {selected === t.id && <div className="task-body" />}
        </div>
      ))}
    </div>
  );
}
