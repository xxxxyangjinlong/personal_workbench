import React, { useEffect, useState } from 'react';
import { api, getToken, setToken, clearToken } from './api';
import { connect, disconnect } from './events';
import Login from './components/Login.jsx';
import Home from './components/Home.jsx';
import Desktop from './components/Desktop.jsx';
import Sessions from './components/Sessions.jsx';
import ThreadView from './components/ThreadView.jsx';
import External from './components/External.jsx';
import Hotspot from './components/Hotspot.jsx';
import XhsRadar from './components/XhsRadar.jsx';

function useWide(query = '(min-width: 900px)') {
  const [wide, setWide] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const m = window.matchMedia(query);
    const onChange = () => setWide(m.matches);
    m.addEventListener('change', onChange);
    setWide(m.matches);
    return () => m.removeEventListener('change', onChange);
  }, [query]);
  return wide;
}

export default function App() {
  const [token, setTok] = useState(getToken());
  const [view, setView] = useState(() => {
    try {
      const v = new URLSearchParams(location.search).get('view');
      if (v === 'hotspot' || v === 'codex' || v === 'xhs') return { name: v };
    } catch {}
    return { name: 'home' };
  });
  const [models, setModels] = useState([]);
  const wide = useWide();

  useEffect(() => {
    if (!token) return;
    connect(token);
    fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token) return;
    api.models().then((r) => setModels((r.data || []).filter((m) => !m.hidden))).catch(() => {});
  }, [token]);

  if (!token) return <Login onLogin={(t) => { setToken(t); setTok(t); }} />;

  const logout = () => { disconnect(); clearToken(); setTok(''); };
  const modelIds = models.map((m) => m.id);

  if (wide) return <div className="app"><Desktop models={modelIds} onLogout={logout} /></div>;

  return (
    <div className="app">
      {view.name === 'home' && (
        <Home
          onOpenCodex={() => setView({ name: 'codex' })}
          onOpenThread={(id) => setView({ name: 'thread', id, from: 'home' })}
          onOpenService={(s) => setView({ name: 'external', service: s })}
          onOpenHotspot={() => setView({ name: 'hotspot' })}
          onOpenRadar={() => setView({ name: 'xhs' })}
          onLogout={logout}
        />
      )}
      {view.name === 'codex' && (
        <Sessions onOpen={(id) => setView({ name: 'thread', id, from: 'codex' })} onBack={() => setView({ name: 'home' })} />
      )}
      {view.name === 'thread' && (
        <ThreadView
          id={view.id}
          models={modelIds}
          onBack={() => setView(view.from === 'home' ? { name: 'home' } : (view.from === 'hotspot' || view.from === 'xhs') ? { name: view.from } : { name: 'codex' })}
          onOpenThread={(nid) => setView({ name: 'thread', id: nid, from: view.from || 'codex' })}
        />
      )}
      {view.name === 'hotspot' && (
        <Hotspot
          onBack={() => setView({ name: 'home' })}
          onOpenThread={(id) => setView({ name: 'thread', id, from: 'hotspot' })}
        />
      )}
      {view.name === 'xhs' && (
        <XhsRadar
          onBack={() => setView({ name: 'home' })}
          onOpenThread={(id) => setView({ name: 'thread', id, from: 'xhs' })}
        />
      )}
      {view.name === 'external' && <External service={view.service} onBack={() => setView({ name: 'home' })} />}
    </div>
  );
}
