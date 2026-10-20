import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import ThreadView from './ThreadView.jsx';
import External from './External.jsx';

function relTime(sec) {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天`;
  const dt = new Date(sec * 1000);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

function groupByProject(projects, threads, keepEmpty) {
  const groups = projects.map((p) => ({ id: p.id, name: p.name, roots: (p.roots || []).map((r) => r.path), threads: [] }));
  const ungrouped = { id: '__none', name: '未归类', roots: [], threads: [] };
  for (const t of threads) {
    const cwd = t.cwd || '';
    const g = groups.find((gr) => gr.roots.some((r) => cwd === r || cwd.startsWith(r + '/')));
    (g || ungrouped).threads.push(t);
  }
  return [
    ...(keepEmpty ? groups : groups.filter((g) => g.threads.length)),
    ...(ungrouped.threads.length ? [ungrouped] : []),
  ];
}

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function Overview({ threads, running, services, pinned, recent, onPick }) {
  const runningCount = (running || []).length;
  const online = services.filter((s) => s.online).length;
  const dateStr = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  return (
    <div className="dhome">
      <div className="dhero2">
        <div className="dhero2-l">
          <div className="dhero2-hi">{greeting()}，欢迎回来</div>
          <div className="dhero2-title">桌面工作台</div>
          <div className="dhero2-sub">本机 Codex 会话 · 数据查询 · 服务器终端，一处直达</div>
        </div>
        <div className="dhero2-r">
          <div className="dhero2-date">{dateStr}</div>
          <div className="dhero2-live">
            <i className={`stdot ${runningCount > 0 ? 'run' : 'on'}`} />
            {runningCount > 0 ? `${runningCount} 个任务运行中` : '当前空闲'}
          </div>
        </div>
      </div>

      <div className="dstats">
        <div className="dstat">
          <div className="dstat-ico blue">💬</div>
          <div>
            <div className="dstat-num">{threads}</div>
            <div className="dstat-lbl">会话总数</div>
          </div>
        </div>
        <div className="dstat">
          <div className="dstat-ico gold">⚡</div>
          <div>
            <div className="dstat-num">{runningCount}</div>
            <div className="dstat-lbl">运行中</div>
          </div>
        </div>
        <div className="dstat">
          <div className="dstat-ico green">✅</div>
          <div>
            <div className="dstat-num">{online}<span className="dstat-den">/{services.length}</span></div>
            <div className="dstat-lbl">服务在线</div>
          </div>
        </div>
      </div>

      <div className="dsec-title">快捷入口</div>
      <div className="dquick">
        {pinned.map((p) => (
          <button key={p.threadId} className="dquickcard" onClick={() => onPick({ type: 'thread', id: p.threadId })}>
            <span className="dq-ico">🚀</span>
            <span className="dq-body">
              <span className="dq-name">{p.label}</span>
              <span className="dq-sub">直达会话</span>
            </span>
            <span className="dq-go">→</span>
          </button>
        ))}
        {services.map((s) => (
          <button key={s.id} className="dquickcard" onClick={() => onPick({ type: 'external', service: s })}>
            <span className="dq-ico">{s.id === 'shell' ? '🖥️' : '🗄️'}</span>
            <span className="dq-body">
              <span className="dq-name">{s.label}</span>
              <span className="dq-sub"><i className={`stdot ${s.online ? 'on' : 'off'}`} />{s.online ? '在线' : '离线'} · 端口 {s.port}</span>
            </span>
            <span className="dq-go">→</span>
          </button>
        ))}
      </div>

      {recent.length > 0 && (
        <>
          <div className="dsec-title">最近会话</div>
          <div className="drecent">
            {recent.map((t) => (
              <button key={t.id} className="drec" onClick={() => onPick({ type: 'thread', id: t.id })}>
                <span className="drec-name">{t.name || (t.preview || '').slice(0, 40) || '(无标题)'}</span>
                <span className="drec-proj">{(t.cwd || '').split('/').pop()}</span>
                <span className="spacer" />
                {running.includes(t.id)
                  ? <span className="stdot run" />
                  : <span className="drec-time">{relTime(t.updatedAt || t.recencyAt || t.createdAt)}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function Desktop({ models, onLogout }) {
  const [services, setServices] = useState([]);
  const [pinned, setPinned] = useState([]);
  const [projects, setProjects] = useState([]);
  const [threads, setThreads] = useState([]);
  const [running, setRunning] = useState([]);
  const [q, setQ] = useState('');
  const [tabs, setTabs] = useState([]);      // [{ key, type, id?, service?, title }]
  const [active, setActive] = useState(null); // 当前标签 key；null = 首页概览

  const refresh = useCallback(() => {
    api.services().then((r) => { setServices(r.services || []); setPinned(r.pinned || []); setRunning(r.running || []); }).catch(() => {});
    api.projects().then((r) => setProjects(r.data || [])).catch(() => {});
    api.threads('?limit=200').then((r) => setThreads(r.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      api.running().then((r) => setRunning(r.running || [])).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  function titleFor(item) {
    if (item.type === 'external') return item.service?.label || '服务';
    const t = threads.find((x) => x.id === item.id);
    return t ? (t.name || (t.preview || '').slice(0, 24) || '会话') : '会话';
  }
  function open(item) {
    const key = item.type === 'thread' ? `thread:${item.id}` : `svc:${item.service.id}`;
    setTabs((prev) => (prev.some((t) => t.key === key) ? prev : [...prev, { key, ...item, title: titleFor(item) }]));
    setActive(key);
  }
  function closeTab(key) {
    const idx = tabs.findIndex((t) => t.key === key);
    const next = tabs.filter((t) => t.key !== key);
    setTabs(next);
    if (active === key) {
      const nb = next[idx] || next[idx - 1] || null;
      setActive(nb ? nb.key : null);
    }
  }
  // 会话改名后同步标签标题
  useEffect(() => {
    setTabs((prev) => prev.map((t) => (t.type === 'thread' ? { ...t, title: titleFor(t) } : t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  async function newThread(root) {
    try {
      const r = await api.createThread(root ? { cwd: root } : {});
      refresh();
      open({ type: 'thread', id: r.thread.id });
    } catch (e) { window.alert('新建会话失败：' + e.message); }
  }

  const filtered = q
    ? threads.filter((t) => ((t.name || '') + (t.preview || '') + (t.cwd || '')).toLowerCase().includes(q.toLowerCase()))
    : threads;
  const groups = groupByProject(projects, filtered, !q);
  const tab = tabs.find((t) => t.key === active) || null;

  return (
    <div className="desk">
      <aside className="deskside">
        <div className="dbrand" onClick={() => setActive(null)} title="回到概览" style={{ cursor: 'pointer' }}>🧭 桌面工作台</div>

        <div className="dnav">
          {pinned.map((p) => (
            <button key={p.threadId} className={`dnavitem ${active === `thread:${p.threadId}` ? 'on' : ''}`}
              onClick={() => open({ type: 'thread', id: p.threadId })}>
              <span className="di">🚀</span>
              <span className="dlbl">{p.label}</span>
            </button>
          ))}
          {services.map((s) => (
            <button key={s.id} className={`dnavitem ${active === `svc:${s.id}` ? 'on' : ''}`}
              onClick={() => open({ type: 'external', service: s })}>
              <span className="di">{s.id === 'shell' ? '🖥️' : '🗄️'}</span>
              <span className="dlbl">{s.label}</span>
              <i className={`stdot ${s.online ? 'on' : 'off'}`} />
            </button>
          ))}
        </div>

        <div className="dsearch">
          <input placeholder="搜索会话…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="dlisthead">Codex 会话</div>
        <div className="dlist">
          {groups.map((g) => (
            <div key={g.id} className="dgroup">
              <div className="dgrouphead">
                <span className="dname">{g.name}</span>
                <span className="dcount">{g.threads.length}</span>
                <span className="spacer" />
                <button className="dadd" title="在该项目新建会话" onClick={() => newThread(g.roots[0])}>＋</button>
              </div>
              {g.threads.length === 0 && <div className="dempty">暂无会话</div>}
              {g.threads.map((t) => (
                <button key={t.id} className={`dthread ${active === `thread:${t.id}` ? 'on' : ''}`}
                  onClick={() => open({ type: 'thread', id: t.id })}>
                  <span className="dtname">{t.name || (t.preview || '').slice(0, 30) || '(无标题)'}</span>
                  {running.includes(t.id)
                    ? <span className="stdot run" />
                    : <span className="dttime">{relTime(t.updatedAt || t.recencyAt || t.createdAt)}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="dfoot">
          <span className="muted">{threads.length} 个会话{running.length ? ` · ${running.length} 运行中` : ''}</span>
          <span className="spacer" />
          <button className="ghost" onClick={onLogout}>退出</button>
        </div>
      </aside>

      <main className="deskmain">
        {tabs.length > 0 && (
          <div className="tabbar">
            {tabs.map((t) => (
              <div key={t.key} className={`tab ${t.key === active ? 'on' : ''}`} onClick={() => setActive(t.key)} title={t.title}>
                {t.type === 'thread' && running.includes(t.id) && <span className="stdot run" />}
                <span className="tabtitle">{t.title}</span>
                <button className="tabx" title="关闭" onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="tabbody">
          {!tab && (
            <Overview threads={threads.length} running={running} services={services}
              pinned={pinned} recent={threads.slice(0, 6)} onPick={open} />
          )}
          {tabs.map((t) => (
            <div key={t.key} className="tabpane" style={{ display: t.key === active ? 'flex' : 'none' }}>
              {t.type === 'thread'
                ? <ThreadView id={t.id} models={models} onBack={() => closeTab(t.key)}
                    onOpenThread={(id) => open({ type: 'thread', id })} />
                : <External service={t.service} onBack={() => closeTab(t.key)} />}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
