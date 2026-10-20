import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { subscribe } from '../events';

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

export default function Sessions({ onOpen, onBack }) {
  const [projects, setProjects] = useState([]);
  const [threads, setThreads] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const [running, setRunning] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(() => Promise.all([api.projects(), api.threads('?limit=100')])
    .then(([p, t]) => { setProjects(p.data || []); setThreads(t.data || []); })
    .catch(() => {}), []);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await reload(); } finally { setTimeout(() => setRefreshing(false), 400); }
  }, [reload]);

  useEffect(() => {
    setLoading(true);
    reload().finally(() => setLoading(false));
    const loadRunning = () => api.running().then((r) => setRunning(r.running || [])).catch(() => {});
    loadRunning();
    const timer = setInterval(loadRunning, 5000);
    return () => clearInterval(timer);
  }, [reload]);

  // SSE (重)连上 / 页面重新可见时刷新列表，避免网关重启后列表过期。
  useEffect(() => subscribe((m) => { if (m.method === '__connected') reload(); }), [reload]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
  }, [reload]);

  async function newThread(g) {
    const cwd = g.roots[0];
    try {
      const r = await api.createThread(cwd ? { cwd } : {});
      onOpen(r.thread.id);
    } catch (e) { window.alert('新建会话失败：' + e.message); }
  }

  async function remove(t) {
    const label = t.name || (t.preview || '').slice(0, 20) || '该会话';
    if (!window.confirm(`删除会话「${label}」？删除后不可恢复。`)) return;
    try {
      await api.deleteThread(t.id);
      setThreads((arr) => arr.filter((x) => x.id !== t.id));
    } catch (e) {
      if (e.status === 409 || /使用中|active writer/.test(e.message || '')) window.alert('该会话正在电脑端使用中，请先在电脑端关闭它再删除。');
      else window.alert('删除失败：' + e.message);
    }
  }

  const filtered = q
    ? threads.filter((t) => ((t.name || '') + (t.preview || '') + (t.cwd || '')).toLowerCase().includes(q.toLowerCase()))
    : threads;
  const groups = groupByProject(projects, filtered, !q);

  return (
    <div className="page">
      <header className="topbar">
        <button className="icon" onClick={onBack}>←</button>
        <span className="title small">Codex 会话</span>
        <div className="spacer" />
        <span className="count-pill">{threads.length} 个</span>
        <button className="icon" title="刷新" onClick={doRefresh} disabled={refreshing}>{refreshing ? '⟳' : '↻'}</button>
      </header>

      <div className="searchrow">
        <input placeholder="搜索会话…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="sessionscroll">
        {loading && <div className="empty">加载中…</div>}
        {!loading && groups.length === 0 && <div className="empty">暂无会话</div>}
        {groups.map((g) => (
          <section key={g.id} className="pgroup">
            <div className="pgrouphead">
              <span className="pavatar">{(g.name || '?').trim().charAt(0).toUpperCase()}</span>
              <span className="pname">{g.name}</span>
              <span className="pcount">{g.threads.length}</span>
              <span className="spacer" />
              <button className="padd" title="在该项目新建会话" onClick={(e) => { e.stopPropagation(); newThread(g); }}>＋</button>
            </div>
            {g.roots[0] && <div className="proot">{g.roots[0]}</div>}
            {g.threads.length === 0 && <div className="ptempty">暂无会话，点右上「＋」新建</div>}
            <ul className="threadlist">
              {g.threads.map((t) => {
                const flags = t.status?.type === 'active' ? (t.status.activeFlags || []) : [];
                const busy = running.includes(t.id);
                const label = flags.includes('waitingOnApproval') ? '待审批'
                  : flags.includes('waitingOnUserInput') ? '待输入'
                  : busy ? '运行中' : '空闲';
                return (
                  <li key={t.id} onClick={() => onOpen(t.id)}>
                    <div className="trow">
                      <div className="tname">{t.name || (t.preview || '').slice(0, 40) || '(无标题)'}</div>
                      <span className={`tstat ${busy ? 'run' : ''} ${flags.length ? 'flag' : ''}`}>
                        <i />{label}
                      </span>
                      <div className="ttime">{relTime(t.updatedAt || t.recencyAt || t.createdAt)}</div>
                      <button className="rowdel" title="删除会话" onClick={(e) => { e.stopPropagation(); remove(t); }}>🗑</button>
                    </div>
                    {t.preview && t.name && <div className="tprev">{t.preview.slice(0, 60)}</div>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
