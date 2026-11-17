// 「今日一屏」数据聚合：今天的会话活动、token 累计（事件推算）、模块状态、机器状态。
// 小红书等能力已拆为独立模块（modules/<id>/），本文件通过模块宿主的 indicator 读取其状态。
import { readFileSync, writeFileSync, mkdirSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { getIndicator, getModule, modulePageUrl } from './modules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_FILE = path.join(__dirname, '..', 'data', 'today-usage.json');

const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// —— token 用量：监听 thread/tokenUsage/updated 通知，按天累计（相对当天首次观测值的增量）——
// data/today-usage.json: { date: 'YYYY-MM-DD', threads: { [threadId]: { first, last } } }
function loadUsage() { try { return JSON.parse(readFileSync(USAGE_FILE, 'utf8')); } catch { return { date: dayStr(), threads: {} }; } }
let usage = loadUsage();
function saveUsage() { try { mkdirSync(path.dirname(USAGE_FILE), { recursive: true }); writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch {} }

export function noteTokenUsage(m) {
  try {
    const p = m.params || {};
    const tid = p.threadId;
    const t = p.tokenUsage || p.token_usage || {};
    const val = Number(t.total?.totalTokens ?? t.total?.total_tokens);
    if (!tid || !Number.isFinite(val)) return;
    const d = dayStr();
    if (usage.date !== d) usage = { date: d, threads: {} };
    const rec = usage.threads[tid] || (usage.threads[tid] = { first: val, last: val });
    if (val > rec.last) rec.last = val;
    if (val < rec.first) rec.first = val; // 会话回滚/重放等异常情况兜底
    saveUsage();
  } catch {}
}
function todayTokens() {
  if (usage.date !== dayStr()) return 0;
  return Object.values(usage.threads).reduce((s, t) => s + Math.max(0, (t.last || 0) - (t.first || 0)), 0);
}

// —— 模块状态（小红书等）：读模块宿主的 indicator 缓存，模块离线时降级显示 ——
function moduleBlock() {
  const m = getModule('xhs');
  if (!m || !m.enabled) return { enabled: false };
  const ind = getIndicator('xhs');
  if (ind.offline) return { enabled: true, offline: true, pageUrl: modulePageUrl('xhs'), label: m.name, icon: m.icon };
  return {
    enabled: true, offline: false, pageUrl: modulePageUrl('xhs'), label: ind.label || m.name, icon: ind.icon || m.icon,
    scanning: !!ind.scanning, lastError: ind.lastError || null,
    today: ind.today || [], next: ind.next || null,
    last: ind.last ? { date: ind.last.date, slot: ind.last.slot, kw: ind.last.kw, type: ind.last.type, typeLabel: ind.last.typeLabel || ind.last.type } : null,
    pool: ind.pool || { total: 0, used: 0, left: 0 },
    top: ind.top || [], snapshotDate: ind.snapshotDate || null,
  };
}

// —— 机器状态 ——
// macOS 的 os.freemem() 不含可回收缓存，直接算「已用%」常年 95+，没有信息量；
// 改用系统自带 memory_pressure -Q 拿真实可用百分比，失败则不展示内存项。
function memFreePct() {
  return new Promise((resolve) => {
    execFile('/usr/bin/memory_pressure', ['-Q'], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /free percentage:\s*(\d+)/.exec(String(stdout));
      resolve(m ? Number(m[1]) : null);
    });
  });
}
async function systemBlock() {
  let disk = null;
  try {
    const st = statfsSync('/');
    if (st && st.blocks) {
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      disk = { usedPct: Math.round(((total - free) / total) * 100), freeGb: Math.round((free / 1024 ** 3) * 10) / 10 };
    }
  } catch {}
  const cores = os.cpus()?.length || 1;
  const memFree = await memFreePct();
  return {
    disk,
    memFreePct: memFree,
    load1: Math.round((os.loadavg()[0] || 0) * 10) / 10,
    cores,
    uptimeDays: Math.round((os.uptime() / 86400) * 10) / 10,
  };
}

export async function todayData({ codex, running = [] }) {
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const todaySec = startOfDay.getTime() / 1000;

  let items = [];
  try {
    await codex.ensureReady();
    const r = await codex.request('thread/list', { limit: 60, sortKey: 'recency_at', sortDirection: 'desc' });
    items = (r.data || []).filter((t) => (t.updatedAt || t.recencyAt || t.createdAt || 0) >= todaySec);
  } catch {}

  const runningSet = new Set(running);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];

  return {
    date: dayStr(now), week,
    threads: {
      active: items.length,
      running: items.filter((t) => runningSet.has(t.id)).length,
      items: items.slice(0, 6).map((t) => ({
        id: t.id, name: t.name || (t.preview || '').slice(0, 30) || '(无标题)',
        preview: t.preview || '', updatedAt: t.updatedAt || t.recencyAt || t.createdAt || 0,
        running: runningSet.has(t.id),
      })),
    },
    tokens: { today: todayTokens() },
    xhs: moduleBlock(),
    system: await systemBlock(),
  };
}
