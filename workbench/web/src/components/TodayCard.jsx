import React, { useEffect, useState } from 'react';
import { api } from '../api';

const TYPE_LABEL = { question: '提问帖', hot: '热点解读', figure: '人物观点', weekly: '汇总帖', devlog: '代码日常', custom: '自定义' };
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function hhmm(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
}
function weekOf(dateStr) {
  if (!dateStr) return '';
  const [y, m, dd] = String(dateStr).split('-').map(Number);
  return WEEK[new Date(y, (m || 1) - 1, dd || 1).getDay()] || '';
}

// 「今日一屏」：今天的会话活动、小红书发布状态/题库余量、雷达榜首、机器状态
export default function TodayCard({ onOpenThread, onOpenCodex, onOpenRadar }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.today().then((r) => { if (alive) setD(r); }).catch(() => {});
    load();
    const iv = setInterval(load, 60000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  if (!d) return null;

  const t = d.threads || {};
  const x = d.xhs || {};
  const s = d.system || {};
  const runningItem = (t.items || []).find((i) => i.running);
  const pool = x.pool || {};
  const next = x.next;
  const tokens = d.tokens?.today || 0;
  const lastItem = (t.items || [])[0];

  return (
    <div className="tdy">
      <div className="tdy-head">今日<span className="tdy-date">{(d.date || '').slice(5).replace('-', '/')} {d.week}</span></div>

      <div className="tdy-row clickable" onClick={() => (runningItem ? onOpenThread(runningItem.id) : onOpenCodex && onOpenCodex())}>
        <span>💬</span>
        <span>会话 <b>{t.active || 0}</b> 个活跃{t.running ? ` · ${t.running} 运行中` : ''}</span>
        <span className="tdy-sub">{lastItem ? `最近 ${hhmm(lastItem.updatedAt)}` : '今天还没有'}</span>
        <span className="chev">›</span>
      </div>

      {tokens > 0 && (
        <div className="tdy-row">
          <span>⚡</span>
          <span>Tokens <b>{tokens.toLocaleString()}</b>（今日累计）</span>
        </div>
      )}

      <div className="tdy-row clickable" onClick={() => { if (x.pageUrl) location.href = x.pageUrl; else onOpenRadar && onOpenRadar(); }}>
        <span>🍠</span>
        {x.offline
          ? <span>模块离线</span>
          : x.enabled === false
          ? <span>自动发帖已关闭</span>
          : (
            <span className="tdy-grow">
              {next
                ? <>下一条 <b>{next.isToday ? '今天' : weekOf(next.date)} {next.slot}</b> · {next.typeLabel}</>
                : (x.today || []).length ? '今天时段已发完' : '近 7 天无排期'}
              {(x.today || []).some((p) => p.missed) && <span className="tdy-warn">（今天有错过的时段）</span>}
            </span>
          )}
        {x.last && x.last.date === d.date && <span className="tdy-sub">已发 {x.last.slot}</span>}
      </div>

      {x.enabled !== false && (
        <div className="tdy-row">
          <span>📝</span>
          <span>题库剩 <b className={pool.left <= 3 ? 'tdy-warn' : ''}>{pool.left}</b>/{pool.total || '?'} 条</span>
          {pool.left <= 3 && <span className="tdy-warn">该补货了</span>}
        </div>
      )}

      {(x.top || []).length > 0 && (
        <div className="tdy-row clickable" onClick={() => onOpenRadar && onOpenRadar()}>
          <span>🔥</span>
          <span className="tdy-chips">
            {x.top.map((k) => <span className="tdy-chip" key={k.kw}>{k.kw} <b>{k.medLikes}</b></span>)}
          </span>
          <span className="tdy-sub">{x.snapshotDate ? `截至 ${String(x.snapshotDate).slice(5)}` : ''}</span>
          <span className="chev">›</span>
        </div>
      )}

      {(s.disk || s.memFreePct != null) && (
        <div className="tdy-row tdy-sub">
          <span>🖥</span>
          <span>
            {s.disk ? `磁盘 ${s.disk.usedPct}%（剩 ${s.disk.freeGb}G）· ` : ''}
            {s.memFreePct != null ? `内存可用 ${s.memFreePct}% · ` : ''}负载 {s.load1}
          </span>
        </div>
      )}
    </div>
  );
}
