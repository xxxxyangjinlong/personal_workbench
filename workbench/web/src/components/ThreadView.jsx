import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api';
import { subscribe } from '../events';
import Item from './Item.jsx';

function mergeItems(a, b) {
  const map = new Map();
  for (const it of a || []) if (it && it.id) map.set(it.id, it);
  for (const it of b || []) if (it && it.id) map.set(it.id, { ...(map.get(it.id) || {}), ...it });
  return [...map.values()];
}
function upsertTurn(turns, turn) {
  if (!turn || !turn.id) return turns;
  const i = turns.findIndex((t) => t.id === turn.id);
  if (i < 0) return [...turns, turn];
  const prev = turns[i];
  const merged = { ...prev, ...turn };
  // 通知里的 turn.items 可能只含部分条目（例如完成时只带 agentMessage），
  // 这里按 id 合并，避免把已渲染的 userMessage 等覆盖丢失。
  if (Array.isArray(turn.items)) merged.items = mergeItems(prev.items, turn.items);
  const copy = [...turns]; copy[i] = merged; return copy;
}
function upsertItem(turns, turnId, item) {
  if (!turnId || !item?.id) return turns;
  const idx = turns.findIndex((t) => t.id === turnId);
  if (idx < 0) return [...turns, { id: turnId, status: 'inProgress', items: [item] }];
  return turns.map((t) => {
    if (t.id !== turnId) return t;
    const items = t.items || [];
    const i = items.findIndex((x) => x.id === item.id);
    const next = i < 0 ? [...items, item] : items.map((x) => (x.id === item.id ? { ...x, ...item } : x));
    return { ...t, items: next };
  });
}
function appendDelta(turns, turnId, itemId, delta) {
  const base = turns.find((t) => t.id === turnId) ? turns : [...turns, { id: turnId, status: 'inProgress', items: [] }];
  return base.map((t) => {
    if (t.id !== turnId) return t;
    const items = t.items || [];
    const i = items.findIndex((x) => x.id === itemId);
    if (i < 0) return { ...t, items: [...items, { type: 'agentMessage', id: itemId, text: delta }] };
    return { ...t, items: items.map((x) => (x.id === itemId ? { ...x, text: (x.text || '') + delta } : x)) };
  });
}

function fmtDur(ms) {
  if (ms == null) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s % 60)} 秒`;
}
function fmtClock(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
function TurnFooter({ turn }) {
  const st = turn?.status || 'inProgress';
  if (st === 'inProgress') {
    return <div className="turnfoot run"><span className="pulse" />正在生成…</div>;
  }
  if (st === 'completed') {
    const parts = [];
    if (turn.durationMs != null) parts.push(`用时 ${fmtDur(turn.durationMs)}`);
    if (turn.completedAt) parts.push(fmtClock(turn.completedAt));
    return <div className="turnfoot done">✓ 已完成{parts.length ? ' · ' + parts.join(' · ') : ''}</div>;
  }
  if (st === 'failed') return <div className="turnfoot err">✗ 失败</div>;
  if (st === 'interrupted') return <div className="turnfoot skip">— 已中断</div>;
  return null;
}

export default function ThreadView({ id, models, onBack, onOpenThread }) {
  const [thread, setThread] = useState(null);
  const [turns, setTurns] = useState([]);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState('');
  const [model, setModel] = useState(localStorage.getItem('cm_model') || '');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);   // { text, images, waited }  等待电脑端释放后自动重发（只发往原会话，不产生副本）
  const [images, setImages] = useState([]);        // [{ dataUrl, name }]
  const [refreshing, setRefreshing] = useState(false);
  const retryTimer = useRef(null);
  const listRef = useRef(null);
  const fileRef = useRef(null);

  const clearRetry = () => { if (retryTimer.current) { clearInterval(retryTimer.current); retryTimer.current = null; } };
  useEffect(() => () => clearRetry(), []);
  useEffect(() => { localStorage.setItem('cm_model', model); }, [model]);

  const refresh = useCallback(() => Promise.all([
    api.thread(id).then((r) => setThread(r.thread)).catch(() => {}),
    // 取“最新”的若干个回合（desc）再倒回正序显示：
    // 默认接口是 asc+limit，长会话会被截断在最早的 N 个回合，看不到最新内容。
    api.turns(id, '?limit=300&sortDirection=desc').then((r) => setTurns([...(r.data || [])].reverse())).catch(() => {}),
  ]), [id]);

  const doRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refresh(); } finally { setTimeout(() => setRefreshing(false), 400); }
  }, [refresh]);

  useEffect(() => {
    clearRetry(); setPending(null); setError('');
    refresh();
  }, [id, refresh]);

  // 页面重新可见 / 获得焦点时重拉一次，避免手机锁屏或长时间挂起后内容过期。
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
  }, [refresh]);

  const onNotif = useCallback((msg) => {
    const m = msg.method; const p = msg.params || {};
    if (m === '__connected') { refresh(); return; }   // SSE (重)连上：补拉断线期间错过的更新
    if (p.threadId && p.threadId !== id) return;
    if (m === 'turn/started') { setRunning(true); setTurns((ts) => upsertTurn(ts, p.turn)); return; }
    if (m === 'turn/completed') { setRunning(false); setTurns((ts) => upsertTurn(ts, p.turn)); return; }
    if (m === 'turn/failed') { setRunning(false); if (p.turn) setTurns((ts) => upsertTurn(ts, p.turn)); return; }
    if (m === 'thread/status/changed') { setRunning(!!p.status && p.status.type !== 'idle'); return; }
    if (m === 'thread/name/updated') { setThread((t) => (t ? { ...t, name: p.name } : t)); return; }
    const turnId = p.turnId || p.turn?.id;
    if (p.item && (m === 'item/started' || m === 'item/completed' || m === 'item/updated')) { setTurns((ts) => upsertItem(ts, turnId, p.item)); return; }
    if (p.itemId && typeof p.delta === 'string') { setTurns((ts) => appendDelta(ts, turnId, p.itemId, p.delta)); return; }
  }, [id, refresh]);
  useEffect(() => subscribe(onNotif), [onNotif]);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [turns]);

  async function trySend(body) {
    return api.sendTurn(id, body);
  }

  function readFile(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve({ dataUrl: r.result, name: file.name || 'image' });
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }
  async function addFiles(fileList) {
    const files = [...(fileList || [])].filter((f) => f && /^image\//.test(f.type));
    if (!files.length) return;
    const list = (await Promise.all(files.map(readFile))).filter(Boolean);
    setImages((arr) => [...arr, ...list]);
  }
  function onPaste(e) {
    const files = e.clipboardData?.files;
    if (files && files.length) { e.preventDefault(); addFiles(files); }
  }

  function startQueue(payload) {
    setPending({ text: payload.text || '', images: payload.images || [], waited: 0 });
    clearRetry();
    retryTimer.current = setInterval(async () => {
      try {
        await trySend({ text: payload.text, model: model || undefined, images: payload.images || undefined });
        clearRetry(); setPending(null); setError('');
      } catch (e) {
        if (e.status !== 409 && e.code !== 'thread_locked') { clearRetry(); setPending(null); setError(e.message); }
        else setPending((pp) => (pp ? { ...pp, waited: (pp.waited || 0) + 5 } : pp));
      }
    }, 5000);
  }

  async function send() {
    const t = text.trim();
    const imgs = images;
    if ((!t && !imgs.length) || running) return;
    setText(''); setImages([]); setError(''); setPending(null);
    setRunning(true);
    try {
      await trySend({ text: t, model: model || undefined, images: imgs.length ? imgs : undefined });
      setRunning(false);
    } catch (e) {
      setRunning(false);
      if (e.status === 409 || e.code === 'thread_locked') startQueue({ text: t, images: imgs });
      else { setText(t); setImages(imgs); setError(e.message); }
    }
  }

  async function retryNow() {
    if (!pending) return;
    try { await trySend({ text: pending.text, model: model || undefined, images: pending.images?.length ? pending.images : undefined }); clearRetry(); setPending(null); }
    catch (e) { if (e.status !== 409 && e.code !== 'thread_locked') { clearRetry(); setPending(null); setError(e.message); } }
  }
  function cancelQueue() { clearRetry(); setPending(null); }

  // 兜底：在副本继续（每会话只复用一份副本，避免产生一堆副本）
  async function forkContinue() {
    const t = pending ? pending.text : text.trim();
    const imgs = pending ? (pending.images || []) : images;
    if (!t && !imgs.length) return;
    const key = 'cm_fork_' + id;
    setError('');
    try {
      let fid = localStorage.getItem(key);
      if (!fid) {
        const r = await api.forkThread(id);
        fid = r.thread.id;
        localStorage.setItem(key, fid);
      }
      await api.sendTurn(fid, { text: t, model: model || undefined, images: imgs.length ? imgs : undefined });
      clearRetry(); setPending(null);
      if (onOpenThread) onOpenThread(fid);
    } catch (e) {
      if (e.status === 409 || e.code === 'thread_locked') setError('副本仍被占用，稍后再试。');
      else setError(e.message);
    }
  }

  async function removeThread() {
    if (!window.confirm('删除该会话？删除后不可恢复。')) return;
    try { await api.deleteThread(id); if (onBack) onBack(); }
    catch (e) { setError(e.status === 409 || /使用中/.test(e.message || '') ? '该会话正在电脑端使用中，请先在电脑端关闭它再删除。' : e.message); }
  }

  async function stop() { try { await api.interrupt(id); } catch (e) { setError(e.message); } setRunning(false); }

  return (
    <div className="page thread">
      <header className="topbar">
        <button className="icon" onClick={onBack}>←</button>
        <span className="title small">{thread?.name || (thread?.preview || '').slice(0, 24) || '任务'}</span>
        <div className="spacer" />
        <span className={`dot ${running ? 'live' : ''}`}>{running ? '运行中' : '空闲'}</span>
        <button className="icon" title="刷新" onClick={doRefresh} disabled={refreshing}>{refreshing ? '⟳' : '↻'}</button>
        <button className="icon" title="删除会话" onClick={removeThread}>🗑</button>
      </header>

      <div className="stream" ref={listRef}>
        {turns.map((turn) => (
          <div key={turn.id} className={`turn ${turn.status === 'inProgress' ? 'running' : ''} ${turn.status === 'completed' ? 'finished' : ''}`}>
            {(turn.items || []).map((it) => <Item key={it.id} item={it} />)}
            {turn.error && <div className="error">{turn.error.message || JSON.stringify(turn.error)}</div>}
            <TurnFooter turn={turn} />
          </div>
        ))}
        {turns.length === 0 && <div className="empty">还没有消息，发一条试试</div>}
      </div>

      {error && <div className="error pad">{error}</div>}
      {pending && (
        <div className="lockbar">
          <div className="lockmsg">
            该会话正在电脑端打开，消息已暂存。在电脑端<b>切走或关闭</b>该会话后会自动发出（已等待 {pending.waited || 0}s）；也可点「在副本继续」兜底。
          </div>
          <div className="lockactions">
            <button className="ghost" onClick={cancelQueue}>取消</button>
            <button className="ghost" onClick={retryNow}>立即重试</button>
            <button onClick={forkContinue}>在副本继续</button>
          </div>
        </div>
      )}

      <div className="composer">
        {images.length > 0 && (
          <div className="thumbs">
            {images.map((im, i) => (
              <div className="thumb" key={i}>
                <img src={im.dataUrl} alt={im.name} />
                <button className="thumbx" title="移除" onClick={() => setImages((a) => a.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
        )}
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">默认模型</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="inputrow">
          <button className="icon attach" title="添加图片" onClick={() => fileRef.current?.click()}>🖼️</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <textarea rows={1} placeholder="给 Codex 发消息…（可粘贴图片）" value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          {running ? <button className="stop" onClick={stop}>停止</button> : <button onClick={send} disabled={!text.trim() && !images.length}>发送</button>}
        </div>
      </div>
    </div>
  );
}
