import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';

const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
function fmtNum(v) {
  const n = Number(v) || 0;
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(Math.round(n));
}
const METRICS = [
  { id: 'medLikes', label: '热度', val: (k) => fmtNum(k.medLikes) + ' 赞' },
  { id: 'medCol', label: '收藏率', val: (k) => pct(k.medCol) },
  { id: 'medSh', label: '转发率', val: (k) => pct(k.medSh) },
];

export default function XhsRadar({ onBack, onOpenThread }) {
  const [data, setData] = useState(null);
  const [metric, setMetric] = useState('medLikes');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.xhsRadar().then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!data?.scanning) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [data?.scanning, load]);

  async function refresh() {
    try { await api.xhsRadarRun(); load(); } catch (e) { setErr(e.message); }
  }

  async function tryPost(type) {
    setBusy('__' + type);
    try {
      const r = await api.xhsRadarPost('仅自己可见', type);
      if (r.threadId) onOpenThread(r.threadId);
      else window.alert('试发失败：' + (r.error || '未知错误'));
    } catch (e) { window.alert('试发失败：' + e.message); }
    finally { setBusy(''); }
  }

  const latest = data?.latest;
  const list = (latest?.keywords || []).filter((k) => !k.err && k.n > 0)
    .sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  const m = METRICS.find((x) => x.id === metric);
  const when = latest?.generatedAt ? new Date(latest.generatedAt) : null;
  const ap = data?.autopost || {};
  const apLabel = (METRICS.find((x) => x.id === ap.metric) || METRICS[0]).label;
  const autoTop = (latest?.keywords || []).filter((k) => !k.err && k.n > 0)
    .sort((a, b) => (b[ap.metric || 'medLikes'] || 0) - (a[ap.metric || 'medLikes'] || 0))[0];

  return (
    <div className="page">
      <header className="topbar">
        <button className="icon" onClick={onBack}>←</button>
        <span className="title">小红书热门</span>
        <div className="spacer" />
        {when && <span className="dot">{when.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} {when.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
        <button className="icon" onClick={refresh} disabled={data?.scanning} title="重新抓取">⟳</button>
      </header>

      <div className="hchips">
        {METRICS.map((x) => (
          <button key={x.id} className={`hchip ${x.id === metric ? 'on' : ''}`} onClick={() => setMetric(x.id)}>{x.label}</button>
        ))}
        {data?.scanning && <span className="hchip off">抓取中…</span>}
      </div>

      <div className="hscroll">
        {err && <div className="error pad">{err}</div>}
        {ap.plan && (
          <div className="hauto">
            每日自动发：{(ap.plan || []).map((p) => `${p.hour}:00 ${p.type === 'ai' ? 'AI分享' : '提问帖'}`).join(' · ')}
            {autoTop && <>（提问帖主题 <b>{autoTop.kw}</b>·{apLabel}第 1 名）</>}
            · 今日 {(ap.doneToday || []).length}/{(ap.plan || []).length}
          </div>
        )}
        {!latest && !data?.scanning && (
          <div className="muted" style={{ padding: 16 }}>
            还没有数据。点右上角 ⟳ 抓一轮（约 5~8 分钟，22 个品类）。
          </div>
        )}
        {data?.scanning && !latest && <div className="muted" style={{ padding: 16 }}>正在抓取各品类小红书数据…</div>}
        {latest && (
          <ul className="hlist">
            {list.map((k, i) => (
              <li key={k.kw} className="hitem">
                <span className={`hrank ${i < 3 ? 'top' + (i + 1) : ''}`}>{i + 1}</span>
                <div className="hbody">
                  <div className="htitle">{k.kw}<span className="hmetric">{m.val(k)}</span></div>
                  <div className="hmeta">
                    <span>中位 {fmtNum(k.medLikes)} 赞</span>
                    <span>收 {pct(k.medCol)}</span>
                    <span>转 {pct(k.medSh)}</span>
                    <span>视频 {pct(k.videoRatio)}</span>
                  </div>
                  {k.topTitle && <div className="htop">热帖：{k.topTitle}（{fmtNum(k.topLikes)} 赞）</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="hfoot">
        <span className="hfoot-line">榜单每日 {data?.hour ?? 8} 点更新 · 试发均为「仅自己可见」</span>
        <div className="hfoot-row">
          <button className="hfoot-btn" onClick={() => tryPost('question')} disabled={!!busy}>{busy === '__question' ? '发起中…' : '试发提问帖'}</button>
          <button className="hfoot-btn" onClick={() => tryPost('ai')} disabled={!!busy}>{busy === '__ai' ? '发起中…' : '试发 AI 分享'}</button>
        </div>
      </div>
    </div>
  );
}
