import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import CreateTask from './components/CreateTask.js';
import TaskList from './components/TaskList.js';
import TaskDetail from './components/TaskDetail.js';
import Radar from './components/Radar.js';
import ChaosPanel from './components/ChaosPanel.js';

type Tab = 'monitor' | 'radar' | 'demo';

export default function App() {
  const [tab, setTab] = useState<Tab>('monitor');
  const [health, setHealth] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [tasks, setTasks] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const [h, m, t] = await Promise.all([api.health(), api.meta(), api.tasks()]);
    setHealth(h);
    setMeta(m);
    setTasks(t.tasks ?? []);
  }, []);

  useEffect(() => {
    refresh();
    // 界面按 4 秒轮询——足以看到调度器真的在动，又不会把服务打爆
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const notify = (kind: string, text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 6000);
  };

  const onCreated = async (id: string) => {
    await refresh();
    setSelected(id);
    setTab('monitor');
  };

  const chaosActive = health?.chaos ?? null;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="mark">◈</span>
          <span>哨兵 Sentinel</span>
          <span className="sub">可配置投资监控与风险雷达</span>
        </div>

        <div className="tabs">
          <button className={`tab ${tab === 'monitor' ? 'active' : ''}`} onClick={() => setTab('monitor')}>
            监控任务 {tasks.length > 0 && <span className="faint">({tasks.length})</span>}
          </button>
          <button className={`tab ${tab === 'radar' ? 'active' : ''}`} onClick={() => setTab('radar')}>
            风险雷达
          </button>
          <button className={`tab ${tab === 'demo' ? 'active' : ''}`} onClick={() => setTab('demo')}>
            演示与破坏
          </button>
        </div>

        <div className="spacer" />

        {chaosActive && (
          <span className="badge-mode" style={{ background: '#2b2410', borderColor: '#6b4e0f', color: '#e3b341' }}>
            ⚠ 故障注入中：{chaosActive}
          </span>
        )}
        <span className={`badge-mode ${meta?.dataSource?.includes('实时') ? 'live' : ''}`}>
          {health?.schedulerRunning ? <span className="live-dot" /> : null}{' '}
          {health?.schedulerRunning ? '调度器运行中' : '调度器已停止'}
        </span>
      </div>

      <div className="main">
        <div className="wrap">
          {toast && (
            <div className={`notice ${toast.kind}`}>
              <span dangerouslySetInnerHTML={{ __html: toast.text }} />
            </div>
          )}

          {tab === 'monitor' && (
            <>
              <CreateTask onCreated={onCreated} notify={notify} />
              <TaskList
                tasks={tasks}
                selected={selected}
                onSelect={(id) => setSelected(selected === id ? null : id)}
                onChanged={refresh}
                notify={notify}
              />
              {selected && (
                <TaskDetail
                  taskId={selected}
                  onClose={() => setSelected(null)}
                  onChanged={refresh}
                  notify={notify}
                />
              )}
            </>
          )}

          {tab === 'radar' && <Radar />}

          {tab === 'demo' && <ChaosPanel meta={meta} chaosActive={chaosActive} onChanged={refresh} notify={notify} />}
        </div>
      </div>
    </div>
  );
}
