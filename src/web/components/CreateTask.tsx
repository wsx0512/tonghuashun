import { useState } from 'react';
import { api } from '../api.js';

const EXAMPLES = [
  '贵州茅台跌破1200元 或者 涨幅超过5%',
  '崇达技术出现涨停',
  '华北制药进入热榜前5',
  '宁德时代回撤超过15%',
  '（贵州茅台跌破1200元 或者 回撤超过10%）并且 崇达技术出现涨停',
  '比亚迪近20日累计涨幅大于15%',
];

/**
 * 自然语言 → 规则。这是主链路的入口。
 *
 * 设计要点：**先把解析结果摊开给用户看，再让他决定是否保存**。
 * 解析不出来的片段会以橙色标注出来，而不是被悄悄丢掉——
 * 这是"可检查"的第一步，也是诚实边界的体现。
 */
export default function CreateTask({
  onCreated,
  notify,
}: {
  onCreated: (id: string) => void;
  notify: (kind: string, text: string) => void;
}) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const doParse = async (t?: string) => {
    const value = (t ?? text).trim();
    if (!value) return;
    setBusy(true);
    setParsed(null);
    try {
      const r = await api.parse(value);
      setParsed(r);
    } finally {
      setBusy(false);
    }
  };

  const doSave = async () => {
    setBusy(true);
    try {
      const r = await api.createTask({ text, name: text.slice(0, 40) });
      if (!r.ok) {
        notify('error', `<span class="title">无法创建</span>${r.message ?? ''}`);
        return;
      }
      notify('info', `已创建监控任务并纳入调度。`);
      setText('');
      setParsed(null);
      onCreated(r.task.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h3 className="panel-title">
        用一句话描述你要盯什么
        <span className="hint">支持价格 / 事件 / 热度 / 日历条件，可用「并且」「或者」组合</span>
      </h3>

      <textarea
        className="nl-input"
        value={text}
        placeholder="例如：贵州茅台跌破1200元 或者 涨幅超过5%，并且出现涨停异动"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doParse();
        }}
      />

      <div className="row mt">
        <button className="btn primary" onClick={() => doParse()} disabled={busy || !text.trim()}>
          解析
        </button>
        {parsed?.ok && (
          <button className="btn" onClick={doSave} disabled={busy}>
            保存为监控任务
          </button>
        )}
        <span className="faint small">Ctrl/⌘ + Enter 解析</span>
      </div>

      <div className="examples">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            className="example"
            onClick={() => {
              setText(e);
              doParse(e);
            }}
          >
            {e}
          </button>
        ))}
      </div>

      {parsed && !parsed.ok && (
        <div className={`notice ${parsed.kind === 'compliance' ? 'warn' : 'error'}`}>
          <span className="title">
            {parsed.kind === 'compliance' ? '这个我做不到' : '没能解析出可监控的条件'}
          </span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{parsed.message}</div>
        </div>
      )}

      {parsed?.ok && (
        <div className="notice info">
          <span className="title">解析结果（请核对后再保存）</span>

          <table className="fields" style={{ marginTop: 6 }}>
            <tbody>
              <tr>
                <th>监控标的</th>
                <td className="val">
                  {(parsed.scope?.subjects ?? []).map((s: any) => `${s.name ?? ''}(${s.thscode})`).join('、')}
                </td>
              </tr>
              <tr>
                <th>条件摘要</th>
                <td className="val">{parsed.summary}</td>
              </tr>
              <tr>
                <th>解析置信度</th>
                <td className="val">{Math.round((parsed.meta?.confidence ?? 0) * 100)}%</td>
              </tr>
            </tbody>
          </table>

          {(parsed.meta?.unresolved ?? []).length > 0 && (
            <div className="notice warn" style={{ marginTop: 8 }}>
              <span className="title">以下片段未能识别，不会纳入监控</span>
              {parsed.meta.unresolved.join('、')}
            </div>
          )}

          {(parsed.warnings ?? []).map((w: string, i: number) => (
            <div key={i} className="notice warn" style={{ marginTop: 8 }}>
              {w}
            </div>
          ))}

          <details style={{ marginTop: 8 }}>
            <summary className="faint small" style={{ cursor: 'pointer' }}>
              查看结构化规则（这就是实际保存的内容）
            </summary>
            <pre className="raw" style={{ marginTop: 6 }}>
              {JSON.stringify(parsed.root, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
