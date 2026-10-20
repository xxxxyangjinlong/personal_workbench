import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';

function fmtHot(v) {
  const n = Number(String(v || '').replace(/[^\d.]/g, ''));
  if (!n) return '';
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

function buildPrompt(item, srcLabel) {
  return [
    '【热点雷达任务】请围绕下面这个热点，写一篇小红书图文笔记，并用 xiaohongshu-mcp 发布。',
    '',
    `热点来源：${srcLabel}热搜`,
    `热点标题：${item.title}`,
    item.url ? `热点链接：${item.url}` : '',
    '',
    '要求：',
    '1. 从「普通人视角」切入，写真实、口语化、带个人体验感的小红书文案（标题≤20字 + 正文 + 5个话题标签），不要写成新闻通稿。',
    '2. 配图：优先复用 ~/workProjects/xiaohongshu-mcp/images/ 下已有图片；没有合适的就用 imagegen 生成 2-3 张契合内容的竖版配图并保存到该目录。发布时图片路径用容器内路径 /app/images/<文件名>。',
    '3. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 先设为「仅自己可见」；把标题、正文、标签和发布结果回报给我，等我确认后再考虑公开。',
  ].filter(Boolean).join('\n');
}

export default function Hotspot({ onBack, onOpenThread }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [active, setActive] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback((refresh) => {
    setLoading(true); setErr('');
    api.hotspot(refresh)
      .then((d) => {
        setData(d);
        setActive((cur) => (cur && d.sources.some((s) => s.id === cur && s.ok) ? cur : (d.sources.find((s) => s.ok)?.id || '')));
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(false); }, [load]);

  const src = (data?.sources || []).find((s) => s.id === active) || null;
  const updated = data?.updatedAt ? new Date(data.updatedAt) : null;

  async function generate(item) {
    setBusy(item.title);
    try {
      const r = await api.createThread({ ...(data?.cwd ? { cwd: data.cwd } : {}), sandbox: 'danger-full-access' });
      const tid = r.thread.id;
      await api.sendTurn(tid, { text: buildPrompt(item, src?.label || '') });
      onOpenThread(tid);
    } catch (e) {
      window.alert('创建任务失败：' + e.message);
    } finally { setBusy(''); }
  }

  return (
    <div className="page">
      <header className="topbar">
        <button className="icon" onClick={onBack}>←</button>
        <span className="title">热点雷达</span>
        <div className="spacer" />
        {updated && <span className="dot">{updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
        <button className="icon" onClick={() => load(true)} disabled={loading} title="刷新">⟳</button>
      </header>

      <div className="hchips">
        {(data?.sources || []).map((s) => (
          <button key={s.id} className={`hchip ${s.id === active ? 'on' : ''} ${s.ok ? '' : 'off'}`} onClick={() => setActive(s.id)}>
            <span className="hchip-ico">{s.icon}</span>
            {s.label}
            {s.ok && <span className="hchip-n">{s.items.length}</span>}
          </button>
        ))}
        {!data && !err && <span className="muted">加载中…</span>}
      </div>

      <div className="hscroll">
        {err && <div className="error pad">{err}</div>}
        {loading && !data && <div className="muted" style={{ padding: 16 }}>正在抓取各平台热搜…</div>}
        {src && !src.ok && <div className="error pad">{src.label}热搜暂时抓取失败：{src.error}</div>}
        {src && src.ok && (
          <ul className="hlist">
            {src.items.map((it) => (
              <li key={it.rank} className="hitem">
                <span className={`hrank ${it.rank <= 3 ? 'top' + it.rank : ''}`}>{it.rank}</span>
                <div className="hbody">
                  <a className="htitle" href={it.url} target="_blank" rel="noreferrer">{it.title}</a>
                  <div className="hmeta">
                    {it.hot && <span className="hhot">🔥 {fmtHot(it.hot)}</span>}
                    {it.label && <span className="hlabel">{it.label}</span>}
                  </div>
                </div>
                <button className="hgen" onClick={() => generate(it)} disabled={!!busy}>
                  {busy === it.title ? '…' : '✍️'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="hfoot">点 ✍️ 让 Codex 生成小红书文案并发草稿（仅自己可见）</div>
    </div>
  );
}
