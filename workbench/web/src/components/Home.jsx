import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';

function relTime(sec) {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天前`;
  const dt = new Date(sec * 1000);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}

export default function Home({ onOpenCodex, onOpenThread, onOpenService, onLogout }) {
  const [services, setServices] = useState([]);
  const [pinned, setPinned] = useState([]);
  const [threadsById, setThreadsById] = useState({});
  const [count, setCount] = useState(0);
  const [running, setRunning] = useState([]);

  const loadRunning = useCallback(() => {
    api.running().then((r) => setRunning(r.running || [])).catch(() => {});
  }, []);

  useEffect(() => {
    api.services()
      .then((r) => { setServices(r.services || []); setPinned(r.pinned || []); setRunning(r.running || []); })
      .catch(() => {});
    api.threads('?limit=100')
      .then((r) => {
        const list = r.data || [];
        setCount(list.length);
        const map = {};
        for (const t of list) map[t.id] = t;
        setThreadsById(map);
      })
      .catch(() => {});
    const timer = setInterval(loadRunning, 5000);
    return () => clearInterval(timer);
  }, [loadRunning]);

  const runningCount = running.length;

  return (
    <div className="page">
      <header className="topbar">
        <span className="title">移动工作台</span>
        <div className="spacer" />
        <button className="icon" onClick={onLogout} title="退出">⏏︎</button>
      </header>

      <div className="homescroll">
        <button className="hero" onClick={onOpenCodex}>
          <span className="hero-ico">🤖</span>
          <div className="hero-text">
            <div className="hero-name">Codex</div>
            <div className="hero-sub">
              {count ? `${count} 个会话` : '按项目查看会话'}
              {runningCount > 0 && <span className="hero-run"> · {runningCount} 个运行中</span>}
            </div>
          </div>
          <span className="chev">›</span>
        </button>

        {runningCount > 0 && (
          <button className="runbar" onClick={() => (runningCount === 1 ? onOpenThread(running[0]) : onOpenCodex())}>
            <span className="pulse" />
            <span>{runningCount} 个任务运行中</span>
            <span className="spacer" />
            <span className="chev">›</span>
          </button>
        )}

        <div className="listhead">功能</div>
        <ul className="functlist">
          {pinned.map((p) => {
                const t = threadsById[p.threadId];
                const isRun = running.includes(p.threadId);
                const ts = t && (t.updatedAt || t.recencyAt || t.createdAt);
                const sub = t?.preview ? t.preview.slice(0, 42) : (isRun ? '运行中' : relTime(ts) || '直达会话');
                return (
                  <li key={p.threadId} onClick={() => onOpenThread(p.threadId)}>
                    <span className="fico">🚀</span>
                    <div className="ftext">
                      <div className="fname">{p.label || t?.name || '会话'}{isRun && <span className="stdot run" />}</div>
                      <div className="fsub">{sub}</div>
                    </div>
            <span className="chev">›</span>
          </li>
          );
          })}
        </ul>
        <div className="listhead">本机服务</div>
        <div className="svcgrid">
          {services.map((s) => (
            <button key={s.id} className={`svccard ${s.online ? 'on' : 'off'}`} onClick={() => onOpenService(s)}>
              <span className="svc-ico">{s.id === 'shell' ? '🖥️' : '🗄️'}</span>
              <span className="svc-name">{s.label}</span>
              <span className="svc-sub">
                <i className={`stdot ${s.online ? 'on' : 'off'}`} />
                {s.online ? '在线' : '离线'} · {s.port}
              </span>
            </button>
          ))}
          {services.length === 0 && <div className="empty">暂无服务</div>}
        </div>

      </div>
    </div>
  );
}
