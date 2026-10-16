import { useEffect, useState } from 'react';
import { api, STATE_LABEL, REASON_LABEL, KIND_LABEL, fmtTime, fmtAge } from '../api.js';

/**
 * 任务详情。
 *
 * 三个标签页对应题目的三个追问：
 *   为什么触发/没触发 → 最近评估（含证据链）
 *   任务是否正常       → 状态变迁时间线
 *   规则改过什么       → 规则版本
 */
export default function TaskDetail({
  taskId,
  onClose,
  onChanged,
  notify,
}: {
  taskId: string;
  onClose: () => void;
  onChanged: () => void;
  notify: (kind: string, text: string) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'why' | 'timeline' | 'versions'>('why');
  const [editText, setEditText] = useState('');
  const [editing, setEditing] = useState(false);

  const load = async () => setData(await api.task(taskId));

  useEffect(() => {
    load();
  }, [taskId]);

  if (!data) return <div className="panel">载入中…</div>;
  const { task, rule, ruleHistory, runs, notifications, deliveries, suppressed, events } = data;

  const bumpRule = async () => {
    const r = await api.updateRule(taskId, { text: editText });
    if (!r.ok) {
      notify('error', `<span class="title">规则未保存</span>${r.message}`);
      return;
    }
    notify('info', `规则已更新为 v${r.rule.version}（历史版本仍保留）`);
    setEditing(false);
    setEditText('');
    await load();
    onChanged();
  };

  return (
    <div className="panel">
      <h3 className="panel-title">
        任务详情
        <span className="hint mono">{task.id}</span>
        <div className="spacer" />
        <button className="btn sm ghost" onClick={onClose}>
          收起
        </button>
      </h3>

      <table className="fields">
        <tbody>
          <tr>
            <th>状态</th>
            <td className="val">
              <span className={`pill ${task.state}`}>{STATE_LABEL[task.state] ?? task.state}</span>
              {task.reasonCode && task.reasonCode !== 'OK' && (
                <span style={{ marginLeft: 8, color: 'var(--warn)' }}>
                  {REASON_LABEL[task.reasonCode] ?? task.reasonCode}
                </span>
              )}
            </td>
          </tr>
          <tr>
            <th>当前规则</th>
            <td className="val">
              v{rule?.version} · {rule?.source?.rawText ?? '（结构化编辑）'}
            </td>
          </tr>
          <tr>
            <th>调度</th>
            <td className="val">
              {task.schedule.kind === 'interval'
                ? `每 ${Math.round(task.schedule.everyMs / 1000)} 秒${task.schedule.tradingHoursOnly ? '（仅交易时段）' : ''}`
                : `每日 ${task.schedule.times.join('、')}${task.schedule.tradingDaysOnly ? '（仅交易日）' : ''}`}
              {' · 下次 '}
              {fmtTime(task.nextRunAt)}
            </td>
          </tr>
          <tr>
            <th>触发策略</th>
            <td className="val">
              {task.policy.triggerMode === 'edge' ? '边沿（条件需复位才再触发）' : '电平（条件为真即可触发）'}
              {' · 冷却 '}
              {task.policy.cooldown.kind === 'trading_day'
                ? '1 个交易日'
                : task.policy.cooldown.kind === 'hours'
                  ? `${task.policy.cooldown.value} 小时`
                  : `${task.policy.cooldown.value} 毫秒`}
              {task.cooldownUntil ? ` · 冷却至 ${fmtTime(task.cooldownUntil)}` : ''}
            </td>
          </tr>
          <tr>
            <th>去重分桶</th>
            <td className="val">
              按条件类型分桶（价格/事件/热度按自然日，日历按月），同一桶内只通知一次
            </td>
          </tr>
        </tbody>
      </table>

      <div className="tabs" style={{ marginTop: 12, marginBottom: 8 }}>
        <button className={`tab ${tab === 'why' ? 'active' : ''}`} onClick={() => setTab('why')}>
          为什么触没触发
        </button>
        <button className={`tab ${tab === 'timeline' ? 'active' : ''}`} onClick={() => setTab('timeline')}>
          状态时间线
        </button>
        <button className={`tab ${tab === 'versions' ? 'active' : ''}`} onClick={() => setTab('versions')}>
          规则版本
        </button>
      </div>

      {tab === 'why' && (
        <WhyTab runs={runs} suppressed={suppressed} notifications={notifications} deliveries={deliveries} />
      )}
      {tab === 'timeline' && <TimelineTab events={events} />}
      {tab === 'versions' && (
        <VersionsTab
          ruleHistory={ruleHistory}
          editing={editing}
          editText={editText}
          setEditing={setEditing}
          setEditText={setEditText}
          onSave={bumpRule}
        />
      )}
    </div>
  );
}

/* ───────────── 为什么触没触发 ───────────── */

function WhyTab({ runs, suppressed, notifications, deliveries }: any) {
  const last = runs?.[0];

  return (
    <div>
      {last ? (
        <div className="evidence">
          <div className="evidence-head">
            <span className={`dot ${last.truth}`} />
            <strong className="small">
              {last.truth === 'unknown'
                ? `无法判定（${REASON_LABEL[last.reason_code] ?? last.reason_code}）`
                : last.truth === 'true'
                  ? '条件命中'
                  : '条件未满足'}
            </strong>
            <span className="tiny faint">
              {fmtTime(last.started_at)} · 规则 {last.rule_version_id} · run {last.id}
            </span>
          </div>
          <div className="evidence-body">
            <div className="narrative" style={{ whiteSpace: 'pre-wrap' }}>
              {last.narrative}
            </div>
            <EvidenceTable runId={last.id} />
          </div>
        </div>
      ) : (
        <div className="empty">还没有评估记录。点任务卡片的「立即评估」。</div>
      )}

      {suppressed?.length > 0 && (
        <>
          <h4 className="panel-title" style={{ marginTop: 14 }}>
            被抑制的触发
            <span className="hint">冷却或去重命中时会留痕，不是静默丢弃</span>
          </h4>
          {suppressed.slice(0, 8).map((s: any) => (
            <div key={s.id} className="tl-item degrade" style={{ paddingBottom: 8 }}>
              <div className="tl-text">{s.reason}</div>
              <div className="tl-meta">{fmtTime(s.created_at)} · leaf {s.leaf_id}</div>
            </div>
          ))}
        </>
      )}

      {notifications?.length > 0 && (
        <>
          <h4 className="panel-title" style={{ marginTop: 14 }}>
            通知记录
          </h4>
          {notifications.slice(0, 10).map((n: any) => {
            // 每条通知都标注"送没送出去"——送不出去时必须看得见，
            // 否则用户会把"没收到"误当成"没触发"。
            const d = deliveries?.find((x: any) => x.notification_id === n.id);
            const badge =
              d == null
                ? { text: '未投递', color: 'var(--fg-dim)' }
                : d.status === 'SENT'
                  ? { text: `已推送${d.attempts > 1 ? `（重试 ${d.attempts - 1} 次）` : ''}`, color: 'var(--ok)' }
                  : d.status === 'SKIPPED'
                    ? { text: '未配置推送渠道', color: 'var(--fg-dim)' }
                    : { text: `推送失败（尝试 ${d.attempts} 次）`, color: 'var(--warn)' };
            return (
              <div key={n.id} className={`tl-item ${n.kind === 'TRIGGERED' ? 'trigger' : ''}`} style={{ paddingBottom: 8 }}>
                <div className="tl-text" style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
                <div className="tl-meta">
                  {fmtTime(n.created_at)} · {n.kind} · 认知级别 {n.epistemic} ·{' '}
                  <span style={{ color: badge.color }}>{badge.text}</span>
                  {d?.last_error && (
                    <span style={{ color: 'var(--fg-dim)' }}>（{d.last_error}）</span>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/** 证据表：一个数字一行，每行都能展开到原始响应 */
function EvidenceTable({ runId }: { runId: string }) {
  const [ev, setEv] = useState<any[]>([]);

  useEffect(() => {
    fetch(`/api/evidence/by-run/${encodeURIComponent(runId)}`)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setEv(d.items ?? []))
      .catch(() => setEv([]));
  }, [runId]);

  if (ev.length === 0) return null;

  return (
    <>
      {ev.map((e: any) => (
        <EvidenceCard key={e.id} leaf={e.payload} />
      ))}
    </>
  );
}

export function EvidenceCard({ leaf }: { leaf: any }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState<any>(null);

  const obs = leaf.observations ?? [];
  const ref = obs[0]?.source?.rawResponseRef;

  const showRaw = async () => {
    if (!ref) return;
    if (!raw) {
      const r = await fetch(`/api/raw/${encodeURIComponent(ref)}`).then((x) => x.json());
      setRaw(r.raw);
    }
    setOpen(!open);
  };

  return (
    <div className="evidence" style={{ marginTop: 8 }}>
      <div className="evidence-head">
        <span className={`dot ${leaf.status}`} />
        <span className="kind-tag">{KIND_LABEL[leaf.conditionKind] ?? leaf.conditionKind}</span>
        <span className="small" style={{ flex: 1 }}>
          {leaf.narrative}
        </span>
      </div>

      <div className="evidence-body">
        <table className="fields">
          <thead>
            <tr>
              <th>观测</th>
              <th>字段</th>
              <th>取值</th>
              <th>单位</th>
              <th>统计口径</th>
              <th>数据时点</th>
              <th>来源端点</th>
            </tr>
          </thead>
          <tbody>
            {obs.map((o: any, i: number) => (
              <tr key={i}>
                <td className="val">{o.label}</td>
                <td>{o.field}</td>
                <td className="val">{typeof o.value === 'number' ? o.value : String(o.value ?? '—')}</td>
                <td>{o.unit ?? '—'}</td>
                <td>{o.statisticBasis ?? '—'}</td>
                <td>{fmtTime(o.dataTimestampMs)}</td>
                <td>{o.source.endpoint}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="tiny faint" style={{ marginTop: 6 }}>
          时效：{leaf.freshness?.fresh ? '新鲜' : '不新鲜'}
          {leaf.freshness?.ageMs != null && <> · 数据年龄 {fmtAge(leaf.freshness.ageMs)}</>}
          {leaf.freshness?.thresholdMs ? <> · 阈值 {fmtAge(leaf.freshness.thresholdMs)}</> : null}
          {leaf.comparison && (
            <>
              {' '}· 比较 {leaf.comparison.lhs} {leaf.comparison.operator} {leaf.comparison.rhs} →{' '}
              {leaf.comparison.passed ? '通过' : '未通过'}
            </>
          )}
        </div>
        {/* 数据不新鲜却仍给出结论时，必须说明为什么——否则读者会以为这是矛盾的 */}
        {leaf.freshness?.note && !leaf.freshness.fresh && (
          <div className="tiny faint" style={{ marginTop: 2, color: 'var(--warn)' }}>
            ↳ {leaf.freshness.note}
          </div>
        )}

        {leaf.conflicts?.length > 0 && (
          <div className="notice warn" style={{ marginTop: 8 }}>
            <span className="title">数据源冲突</span>
            {leaf.conflicts.map((c: any, i: number) => (
              <div key={i} className="small">
                {c.field}：{c.sourceA} = {c.valueA} 与 {c.sourceB} = {c.valueB} 相差{' '}
                {(c.deltaPct * 100).toFixed(2)}%
              </div>
            ))}
          </div>
        )}

        {ref && (
          <div style={{ marginTop: 8 }}>
            <button className="btn sm ghost" onClick={showRaw}>
              {open ? '收起原始响应' : '查看原始响应'}
            </button>
            <span className="tiny faint" style={{ marginLeft: 8 }}>
              request_id: {obs[0]?.source?.requestId ?? '—'} · 参数{' '}
              {JSON.stringify(obs[0]?.source?.requestParams ?? {})}
            </span>
            {open && raw && (
              <pre className="raw" style={{ marginTop: 6 }}>
                {JSON.stringify({ endpoint: raw.endpoint, params: raw.params, code: raw.code, request_id: raw.request_id, body: raw.body }, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────── 时间线 ───────────── */

function TimelineTab({ events }: any) {
  if (!events?.length) return <div className="empty">暂无状态变迁记录。</div>;
  const cls = (k: string) =>
    k === 'STATE_CHANGE'
      ? 'trigger'
      : k.includes('ARCHIVED')
        ? 'fail'
        : '';
  return (
    <div className="timeline">
      {events.map((e: any) => (
        <div key={e.id} className={`tl-item ${cls(e.kind)}`}>
          <div className="tl-text">
            <strong>{e.kind}</strong>
            {e.from_state && e.to_state && (
              <>
                {' '}
                <span className="mono">{STATE_LABEL[e.from_state] ?? e.from_state}</span> →{' '}
                <span className="mono">{STATE_LABEL[e.to_state] ?? e.to_state}</span>
              </>
            )}
            {e.payload_json && (
              <span className="faint small"> · {e.payload_json}</span>
            )}
          </div>
          <div className="tl-meta">{fmtTime(e.created_at)}</div>
        </div>
      ))}
    </div>
  );
}

/* ───────────── 规则版本 ───────────── */

function VersionsTab({ ruleHistory, editing, editText, setEditing, setEditText, onSave }: any) {
  return (
    <div>
      <div className="notice info">
        规则每次修改都会生成新版本并保留历史，**旧版本不可回改**。
        每条评估结果都绑定当时生效的版本，所以「昨天为什么没触发」可以精确回答。
      </div>

      <div className="timeline" style={{ marginTop: 12 }}>
        {[...ruleHistory].reverse().map((r: any) => (
          <div key={r.id} className="tl-item trigger">
            <div className="tl-text">
              <strong>v{r.version}</strong> · {r.rawText ?? '（结构化编辑）'}
            </div>
            <div className="tl-meta">
              {fmtTime(r.createdAt)} · 来源 {r.author}
            </div>
          </div>
        ))}
      </div>

      {!editing ? (
        <button className="btn" style={{ marginTop: 10 }} onClick={() => setEditing(true)}>
          修改规则（生成新版本）
        </button>
      ) : (
        <div style={{ marginTop: 10 }}>
          <textarea
            className="nl-input"
            value={editText}
            placeholder="用一句话描述新的监控条件，例如：贵州茅台跌破1300元"
            onChange={(e) => setEditText(e.target.value)}
          />
          <div className="row mt">
            <button className="btn primary" onClick={onSave} disabled={!editText.trim()}>
              保存为新版本
            </button>
            <button className="btn ghost" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
