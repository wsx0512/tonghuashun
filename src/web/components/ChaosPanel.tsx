import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * 演示与破坏面板 —— 让「降级」变成可演示、可复现的能力。
 *
 * 为什么这个面板重要：真实行情源下你**无法按需制造**「数据过期 3 小时」
 * 或「上游返回 code 5003」。没有确定性故障注入，题目要求的
 * 「数据过期/冲突/失败时如何降级并向用户解释」就只能靠嘴说。
 */
export default function ChaosPanel({
  meta,
  chaosActive,
  onChanged,
  notify,
}: {
  meta: any;
  chaosActive: string | null;
  onChanged: () => void;
  notify: (kind: string, text: string) => void;
}) {
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [rejects, setRejects] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const c = await api.chaos();
    setScenarios(c.scenarios ?? []);
    const r = await api.complianceRejects();
    setRejects(r.rejects ?? []);
  };

  useEffect(() => {
    load();
  }, []);

  const apply = async (id: string | null) => {
    setBusy(true);
    try {
      await api.setChaos(id);
      notify(
        id ? 'warn' : 'info',
        id
          ? `已注入故障：${scenarios.find((s) => s.id === id)?.label ?? id}。点「立即评估」查看降级表现。`
          : '已恢复正常数据。',
      );
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  /** 一键：注入故障 → 对所有任务立即评估 → 用户立刻看到降级 */
  const injectAndRun = async (id: string) => {
    setBusy(true);
    try {
      await api.setChaos(id);
      const t = await api.tasks();
      for (const task of t.tasks ?? []) {
        if (task.state === 'PAUSED' || task.state === 'ARCHIVED') continue;
        await api.run(task.id);
      }
      const label = scenarios.find((s) => s.id === id)?.label ?? id;
      notify('warn', `已注入「${label}」并对全部任务重新评估。切到「监控任务」看降级说明。`);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="panel">
        <h3 className="panel-title">
          数据来源
          <span className="hint">如实披露，不假装是真实接口</span>
        </h3>
        <table className="fields">
          <tbody>
            <tr>
              <th>当前来源</th>
              <td className="val">{meta?.dataSource ?? '—'}</td>
            </tr>
            <tr>
              <th>说明</th>
              <td className="val" style={{ fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>
                {meta?.dataSourceNote ?? '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3 className="panel-title">
          故障注入
          <span className="hint">
            在回放层做变异，因此每次结果完全一致——视频演示与测试都靠它
          </span>
          <div className="spacer" />
          {chaosActive && (
            <button className="btn sm" onClick={() => apply(null)} disabled={busy}>
              恢复正常
            </button>
          )}
        </h3>

        <div className="chaos-grid">
          {scenarios.map((s) => (
            <button
              key={s.id}
              className={`chaos-btn ${chaosActive === s.id ? 'active' : ''}`}
              onClick={() => injectAndRun(s.id)}
              disabled={busy}
            >
              <span className="lbl">
                {s.label}
                {chaosActive === s.id && <span className="faint"> · 生效中</span>}
              </span>
              <span className="desc">{s.desc}</span>
            </button>
          ))}
        </div>

        <div className="notice info" style={{ marginTop: 14 }}>
          <span className="title">建议的演示流程（约 90 秒）</span>
          1. 「监控任务」里挑一个正常任务，展开看**证据链**（来源 / 时点 / 单位 / 口径 / request_id）<br />
          2. 回到这里点「数据过期」→ 任务变为**降级**，点开看中文解释：明确说"无法判定"，而不是"未触发"<br />
          3. 再点「源冲突」→ 看到两个数据源的值**并列展示**，没有被静默二选一<br />
          4. 点「恢复正常」→ 收到**恢复通知**，任务回到监控中
        </div>
      </div>

      <div className="panel">
        <h3 className="panel-title">
          合规拦截记录
          <span className="hint">被拒绝的预测/建议类请求会留痕，可追溯</span>
        </h3>
        {rejects.length === 0 ? (
          <div className="empty">
            暂无记录。试试在输入框里问「茅台会涨吗」或「什么时候买入宁德时代」。
          </div>
        ) : (
          <table className="fields">
            <thead>
              <tr>
                <th>输入</th>
                <th>拦截原因</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {rejects.map((r: any) => (
                <tr key={r.id}>
                  <td className="val">{r.raw_text}</td>
                  <td style={{ color: 'var(--warn)' }}>{r.label}</td>
                  <td>{new Date(r.created_at).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h3 className="panel-title">已知边界与未做事项</h3>
        <div className="small dim" style={{ lineHeight: 1.9 }}>
          <strong style={{ color: 'var(--fg)' }}>能力边界</strong>
          <ul style={{ margin: '4px 0 12px', paddingLeft: 20 }}>
            <li>自然语言解析是**确定性词典+模式**，不是模型。解析不出的片段会如实报告，不会猜。</li>
            <li>支持：价格阈值 / 涨跌幅 / 回撤 / 区间累计涨幅、涨停跌停炸板连板、龙虎榜、异动、监控名单、热榜排名、交易日历。</li>
            <li>不支持：主观描述（"走势健康"）、需要新闻语义的开放事件、嵌套超过 3 层的条件。</li>
            <li>扶摇有 8 个能力标注「暂未开放外部接入」（含资讯事件库、主力资金），真实数据模式下相关条件会长期降级。</li>
          </ul>

          <strong style={{ color: 'var(--fg)' }}>未做事项</strong>
          <ul style={{ margin: '4px 0 12px', paddingLeft: 20 }}>
            <li>真实推送渠道（邮件 / 微信 / Webhook）未接，只做站内通知。</li>
            <li>不做回测，不做涨跌预测——这是产品定位，不是未完成项。</li>
            <li>多用户与鉴权未做，当前是演示级单用户。</li>
            <li>关注池目前按静态清单展开，不支持动态增删成员。</li>
          </ul>

          <strong style={{ color: 'var(--fg)' }}>合规声明</strong>
          <div>
            本产品不预测涨跌、不承诺收益、不构成买卖建议。所有结论只陈述**已发生的事实**，
            并明确标注数据来源、时点、单位与统计口径。无法判定时明确说"无法判定"，
            绝不静默给出"正常"结论。
          </div>
        </div>
      </div>
    </div>
  );
}
