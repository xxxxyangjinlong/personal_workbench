// 小红书热门雷达：按关键词抓「最多点赞」笔记，统计热度/收藏率/转发率，按天归档。
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XHS_KEYWORDS, XHS_RADAR_HOUR } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'xhs-radar');
const MCP_URL = process.env.XHS_MCP_URL || 'http://127.0.0.1:18060/mcp';

let sid = null;
let rid = 0;
let running = false;
let lastError = null;
let lastRunAt = 0;

export const isScanning = () => running;

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'xhs-radar', version: '1' } } }),
  });
  sid = r.headers.get('mcp-session-id');
  await r.text();
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {});
}

async function mcpCall(name, args, allowRetry = true) {
  if (!sid) await mcpInit();
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
  });
  const t = await r.text();
  let j = null;
  try { j = t.trim().startsWith('{') ? JSON.parse(t) : JSON.parse((t.match(/data:\s*(\{.*)/s) || [])[1]); } catch { j = null; }
  if (!j || j.error) {
    if (allowRetry) { sid = null; await mcpInit(); return mcpCall(name, args, false); }
    throw new Error(j?.error?.message || 'MCP 调用失败');
  }
  const text = (j.result?.content || []).find((x) => x.type === 'text')?.text;
  if (!text) return {};
  try { return JSON.parse(text); } catch { return { _text: text }; }
}

const toNum = (s) => { if (!s) return 0; const v = String(s); return v.includes('万') ? parseFloat(v) * 1e4 : (parseFloat(v) || 0); };
const med = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

async function scanKeyword(kw) {
  const res = await mcpCall('search_feeds', { keyword: kw, filters: { sort_by: '最多点赞', publish_time: '一周内', note_type: '不限', search_scope: '不限', location: '不限' } });
  const rows = (res.feeds || []).map((f) => {
    const i = f.noteCard?.interactInfo || {};
    return { title: f.noteCard?.displayTitle || '', liked: toNum(i.likedCount), col: toNum(i.collectedCount), sh: toNum(i.sharedCount), cm: toNum(i.commentCount), type: f.noteCard?.type };
  }).filter((r) => r.liked > 0);
  const likes = rows.map((r) => r.liked);
  const base = rows.filter((r) => r.liked >= 200);
  const top = [...rows].sort((a, b) => b.liked - a.liked)[0] || {};
  return {
    kw, n: rows.length,
    medLikes: Math.round(med(likes)), maxLikes: Math.round(Math.max(0, ...likes)),
    medCol: +med(base.map((r) => r.col / r.liked)).toFixed(2),
    medSh: +med(base.map((r) => r.sh / r.liked)).toFixed(2),
    videoRatio: rows.length ? +(rows.filter((r) => r.type === 'video').length / rows.length).toFixed(2) : 0,
    topTitle: top.title || '', topLikes: Math.round(top.liked || 0), topCol: Math.round(top.col || 0),
  };
}

export async function runScan({ reason = 'manual' } = {}) {
  if (running) return { ok: false, error: 'already running' };
  running = true; lastError = null;
  try {
    const keywords = [];
    for (const kw of XHS_KEYWORDS) {
      try { keywords.push(await scanKeyword(kw)); }
      catch (err) { keywords.push({ kw, n: 0, err: String(err?.message || err) }); }
      await new Promise((r) => setTimeout(r, 1200));
    }
    const okCount = keywords.filter((k) => !k.err && k.n > 0).length;
    if (okCount === 0) throw new Error('全部关键词抓取失败（MCP 服务是否在运行？）');
    const snapshot = { date: today(), generatedAt: Date.now(), reason, okCount, keywords };
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path.join(DATA_DIR, `${snapshot.date}.json`), JSON.stringify(snapshot, null, 1));
    lastRunAt = Date.now();
    console.log(`[xhs-radar] 完成：${snapshot.date}，成功 ${okCount}/${keywords.length}`);
    return { ok: true, snapshot };
  } catch (err) {
    lastError = String(err?.message || err);
    console.error('[xhs-radar] 失败:', lastError);
    return { ok: false, error: lastError };
  } finally { running = false; }
}

export function getLatestSnapshot() {
  try {
    if (!existsSync(DATA_DIR)) return null;
    const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) return null;
    return JSON.parse(readFileSync(path.join(DATA_DIR, files[files.length - 1]), 'utf8'));
  } catch { return null; }
}

export function listSnapshots() {
  try { return existsSync(DATA_DIR) ? readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => f.replace('.json', '')) : []; }
  catch { return []; }
}

function maybeDaily() {
  const h = new Date().getHours();
  const has = existsSync(path.join(DATA_DIR, `${today()}.json`));
  if (!has && h >= XHS_RADAR_HOUR && !running) runScan({ reason: 'daily' }).catch(() => {});
}

export function startScheduler() {
  maybeDaily();
  const t = setInterval(maybeDaily, 20 * 60 * 1000);
  t.unref?.();
  console.log(`[xhs-radar] 每 ${XHS_RADAR_HOUR}:00 起自动扫描；关键词 ${XHS_KEYWORDS.length} 个`);
}

export function radarMeta() {
  return { scanning: running, lastError, lastRunAt, keywords: XHS_KEYWORDS, hour: XHS_RADAR_HOUR, dates: listSnapshots() };
}
