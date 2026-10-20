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

function buildPrompt(k) {
  return [
    `【小红书选题任务】品类：${k.kw}`,
    '',
    `先参考我抓到的该品类数据（近一周、按最多点赞口径）：中位点赞 ${fmtNum(k.medLikes)}、收藏率 ${pct(k.medCol)}、转发率 ${pct(k.medSh)}、视频占比 ${pct(k.videoRatio)}。`,
    '',
    '请你：',
    `1. 用 xiaohongshu-mcp 的 search_feeds 搜「${k.kw}」（sort_by=最多点赞），看 5~10 条，总结这个品类的标题套路和内容形式（只借鉴结构，不要照抄内容）。`,
    '2. 结合我的特点（程序员、日常在用 AI 工具、有自建工作台），给出 3 个「本品类 + 我的视角」的选题，覆盖不同风格（干货 / 情绪共鸣 / 个人故事）。',
    '3. 每个选题给：标题（≤20 字）+ 一句话切入角度 + 建议配图方向。',
    '4. 先只输出选题清单，不要写正文、不要发布；等我选定方向。',
  ].join('\n');
}

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

  async function pick(k) {
    setBusy(k.kw);
    try {
      const r = await api.createThread({ ...(data?.cwd ? { cwd: data.cwd } : {}), sandbox: 'danger-full-access' });
      await api.sendTurn(r.thread.id, { text: buildPrompt(k) });
      onOpenThread(r.thread.id);
    } catch (e) { window.alert('创建任务失败：' + e.message); }
    finally { setBusy(''); }
  }

  async function tryPost() {
    setBusy('__post');
    try {
      const r = await api.xhsRadarPost('仅自己可见');
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
        {autoTop && (
          <div className="hauto">
            自动发帖主题：<b>{autoTop.kw}</b>（{apLabel}第 1 名）· 每天 {(ap.hours || []).map((h) => h + ':00').join(' / ')} · 今日 {(ap.doneToday || []).length}/{(ap.hours || []).length}
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
                <button className="hgen" onClick={() => pick(k)} disabled={!!busy}>{busy === k.kw ? '…' : '🎯'}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="hfoot">
        <span className="hfoot-line">点 🎯 出选题 · 每日 {data?.hour ?? 8} 点更新榜单</span>
        <button className="hfoot-btn" onClick={tryPost} disabled={!!busy}>{busy === '__post' ? '发起中…' : '试发一篇（仅自己可见）'}</button>
      </div>
    </div>
  );
}
