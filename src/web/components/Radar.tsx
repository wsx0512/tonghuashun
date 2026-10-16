import { useEffect, useState } from 'react';
import { api, STATE_LABEL, REASON_LABEL, KIND_LABEL, fmtTime } from '../api.js';

/**
 * 风险雷达。
 *
 * 按「维度 × 状态」聚合，让用户一眼看出**哪里是盲区**——
 * 降级任务被明确标出，因为「无法判定」比「未触发」更需要被看见。
 *
 * 这里只呈现已发生的事实与盲区，不做任何涨跌判断。
 */
export default function Radar() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const load = () => api.radar().then(setData);
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  if (!data) return <div className="panel">载入中…</div>;
  const { rows, matrix, summary } = data;

  const cellClass = (state: string, count: number) => {
    if (count === 0) return 'zero';
    if (state === 'DEGRADED' || state === 'FAILED') return 'bad';
    if (state === 'COOLDOWN') return 'hot';
    return '';
  };

  return (
    <div>
      <div className="stat-row">
        <div className="stat">
          <div className="label">监控任务</div>
          <div className="value">{summary.total}</div>
        </div>
        <div className="stat">
          <div className="label">近 7 天触发</div>
          <div className="value" style={{ color: 'var(--ok)' }}>{summary.triggered7d}</div>
        </div>
        <div className="stat">
          <div className="label">降级中</div>
          <div className="value" style={{ color: summary.degraded ? 'var(--warn)' : 'var(--fg-faint)' }}>
            {summary.degraded}
          </div>
        </div>
        <div className="stat">
          <div className="label">失败</div>
          <div className="value" style={{ color: summary.failed ? 'var(--danger)' : 'var(--fg-faint)' }}>
            {summary.failed}
          </div>
        </div>
        <div className="stat">
          <div className="label">被抑制（去重/冷却）</div>
          <div className="value" style={{ color: 'var(--fg-dim)' }}>{summary.suppressed7d}</div>
        </div>
      </div>

      <div className="panel">
        <h3 className="panel-title">
          维度 × 状态矩阵
          <span className="hint">降级与失败是盲区，比"未触发"更需要关注</span>
        </h3>
        <table className="matrix">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>条件维度</th>
              {['PENDING', 'COOLDOWN', 'DEGRADED', 'FAILED', 'PAUSED'].map((s) => (
                <th key={s}>{STATE_LABEL[s]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row: any) => (
              <tr key={row.dim}>
                <td className="dim-label">{KIND_LABEL[row.dim] ?? row.dim}</td>
                {row.cells.map((c: any) => (
                  <td key={c.state} className={cellClass(c.state, c.count)}>
                    <span className="n">{c.count}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 className="panel-title">任务清单</h3>
        {rows.length === 0 && <div className="empty">还没有任务。</div>}
        {rows.map((r: any) => (
          <div key={r.taskId} className="evidence" style={{ marginBottom: 8 }}>
            <div className="evidence-head">
              <span className={`pill ${r.state}`}>{STATE_LABEL[r.state] ?? r.state}</span>
              <strong className="small">{r.name}</strong>
              <div className="spacer" />
              {r.kinds.map((k: string) => (
                <span key={k} className="kind-tag">{KIND_LABEL[k] ?? k}</span>
              ))}
            </div>
            <div className="evidence-body">
              <table className="fields">
                <tbody>
                  <tr>
                    <th>近 7 天</th>
                    <td className="val">
                      触发 {r.triggered7d} · 解除 {r.recovered7d} · 抑制 {r.suppressed}
                    </td>
                  </tr>
                  <tr>
                    <th>上次评估</th>
                    <td className="val">
                      {fmtTime(r.lastEvaluatedAt)}
                      {r.reasonCode && r.reasonCode !== 'OK' && (
                        <span style={{ color: 'var(--warn)', marginLeft: 8 }}>
                          {REASON_LABEL[r.reasonCode] ?? r.reasonCode}
                        </span>
                      )}
                    </td>
                  </tr>
                  {r.degradedSince && (
                    <tr>
                      <th>降级始于</th>
                      <td className="val" style={{ color: 'var(--warn)' }}>{fmtTime(r.degradedSince)}</td>
                    </tr>
                  )}
                  {r.latestNarrative && (
                    <tr>
                      <th>最新结论</th>
                      <td className="val" style={{ whiteSpace: 'pre-wrap' }}>{r.latestNarrative}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="small faint">
          说明：本视图只呈现**已发生的事实**与**监控盲区**（数据过期、源冲突、接口失败导致无法判定的条件），
          不包含任何涨跌预测或买卖建议。
        </div>
      </div>
    </div>
  );
}
