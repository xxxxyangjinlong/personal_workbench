import React, { useEffect, useState } from 'react';
import { api } from '../api';

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
function fmtDays(days) {
  if (!Array.isArray(days) || days.length === 7) return '每天';
  if (!days.length) return '每天';
  return '周' + days.map((d) => DAY_LABELS[d]).join('');
}

export default function Alarm({ onBack }) {
  const [items, setItems] = useState([]);
  const [provider, setProvider] = useState('');
  const [kind, setKind] = useState('mock');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ time: '07:00', to: '', label: '起床闹钟', message: '', days: [1, 2, 3, 4, 5] });

  const load = () => api.alarms().then((r) => { setItems(r.data || []); setProvider(r.provider || ''); setKind(r.kind || 'mock'); }).catch(() => {});
  useEffect(() => { load(); }, []);

  function toggleDay(d) {
    setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort((a, b) => a - b) }));
  }
  async function add() {
    setMsg('');
    if (!/^\d{2}:\d{2}$/.test(form.time)) { setMsg('时间格式应为 HH:MM'); return; }
    if (kind === 'call' && !form.to.trim()) { setMsg('电话通道需要填手机号'); return; }
    try {
      await api.addAlarm({ ...form, days: form.days.length ? form.days : [0, 1, 2, 3, 4, 5, 6] });
      setForm((f) => ({ ...f, to: '', message: '' }));
      setMsg('已添加');
      load();
    } catch (e) { setMsg('添加失败：' + e.message); }
  }
  async function del(id) {
    if (!window.confirm('删除这个闹钟？')) return;
    try { await api.deleteAlarm(id); load(); } catch (e) { setMsg(e.message); }
  }
  async function toggle(a) {
    try { await api.updateAlarm(a.id, { enabled: !a.enabled }); load(); } catch (e) { setMsg(e.message); }
  }
  async function test(a) {
    setMsg('正在发起…');
    try {
      const r = await api.testAlarm(a.id);
      setMsg(r.result?.mocked ? '试触发已记录（模拟模式：未真的响）' : (r.result?.pushed ? '已推送，看下手机' : '已发起呼叫'));
    } catch (e) { setMsg('试拨失败：' + e.message); }
  }

  return (
    <div className="page">
      <header className="topbar">
        <button className="icon" onClick={onBack}>←</button>
        <span className="title small">起床闹钟</span>
        <div className="spacer" />
        <span className={`dot ${provider && provider !== 'mock' ? 'live' : ''}`}>{provider === 'mock' ? '模拟模式' : (kind === 'push' ? `推送·${provider}` : kind === 'voip' ? `网络电话·${provider}` : `电话·${provider}`)}</span>
      </header>

      <div className="homescroll">
        {provider === 'mock' && (
          <div className="notice">现在是「模拟模式」：到点只在服务端记日志，<b>不会真的响</b>。配好通道（免费推送或付费电话）后自动生效。</div>
        )}
        {kind === 'push' && (
          <div className="notice">当前是<b>免费推送模式</b>（{provider}）：到点会往你手机推一条高优先级响铃通知。不如电话强制，但能叫醒人且不花钱。</div>
        )}
        {kind === 'voip' && (
          <div className="notice">当前是<b>免费网络电话模式</b>（{provider}）：到点 IFTTT 会用网络电话呼叫你的手机并朗读内容，<b>手机需装 IFTTT App</b>，无需填手机号。</div>
        )}

        <div className="listhead">已设置的闹钟</div>
        {items.length === 0 && <div className="empty">还没有闹钟，下面加一个</div>}
        <ul className="alarmlist">
          {items.map((a) => (
            <li key={a.id} className={`alarmrow ${a.enabled ? '' : 'off'}`}>
              <div className="atime">{a.time}</div>
              <div className="abody">
                <div className="alabel">{a.label || '起床闹钟'}{!a.enabled && <span className="muted">（已停用）</span>}</div>
                <div className="asub">{a.to} · {fmtDays(a.days)}{a.lastFired ? ` · 上次 ${a.lastFired}` : ''}</div>
              </div>
              <div className="aacts">
                <button className="ghost tiny" onClick={() => test(a)}>试拨</button>
                <button className="ghost tiny" onClick={() => toggle(a)}>{a.enabled ? '停用' : '启用'}</button>
                <button className="ghost tiny" onClick={() => del(a.id)}>🗑</button>
              </div>
            </li>
          ))}
        </ul>

        <div className="listhead">新增闹钟</div>
        <div className="card settings">
          <label>时间</label>
          <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          <label>手机号{kind === 'call' ? '' : '（本通道可不填）'}</label>
          <input inputMode="tel" placeholder="如 13800138000" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
          <label>名称</label>
          <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <label>播报内容（留空则默认「起床啦，该起床了！」）</label>
          <input placeholder="起床啦，该起床了！" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          <label>重复</label>
          <div className="dayrow">
            {DAY_LABELS.map((d, i) => (
              <button key={i} className={`day ${form.days.includes(i) ? 'on' : ''}`} onClick={() => toggleDay(i)}>{d}</button>
            ))}
          </div>
          <button onClick={add}>添加闹钟</button>
          {msg && <div className="muted small">{msg}</div>}
        </div>
      </div>
    </div>
  );
}
