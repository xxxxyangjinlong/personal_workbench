// 小红书自动化模块服务（HTTP 型模块：由安装者独立运行，宿主只转发不拉起）
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexClient } from './codex-client.mjs';
import { runScan, getLatestSnapshot, radarMeta } from './xhs-radar.mjs';
import { autopostMeta, postNow, postCustom, startAutopost } from './xhs-autopost.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.XHS_PORT || 8790);
const PAGE_FILE = path.join(__dirname, 'page.html');
const TYPE_LABEL = { question: '提问帖', hot: '热点解读', figure: '人物观点', weekly: '汇总帖', devlog: '代码日常', custom: '自定义' };

const codex = new CodexClient({ wsUrl: process.env.APP_SERVER_WS || '' });
codex.start().catch((e) => console.error('[xhs] app-server 连接失败:', e.message));

function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function slotStr(p) { return `${String(p.hour).padStart(2, '0')}:${String(p.minute || 0).padStart(2, '0')}`; }

// 模块状态汇总（宿主 indicator 轮询 + 今日一屏小红书行的数据源）
function indicator() {
  const meta = autopostMeta();
  const rm = radarMeta();
  const now = new Date();
  const dow = ((now.getDay() + 6) % 7) + 1; // 1=周一 … 7=周日
  const plan = meta.plan || [];
  const doneToday = meta.doneToday || [];
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const today = plan
    .filter((p) => p.weekday === dow)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
    .map((p) => {
      const slot = slotStr(p);
      return { slot, type: p.type, typeLabel: TYPE_LABEL[p.type] || p.type, done: doneToday.includes(slot), missed: !doneToday.includes(slot) && nowMin > p.hour * 60 + (p.minute || 0) + 59 };
    });

  let next = null;
  for (let off = 0; off < 8 && !next; off++) {
    const d = new Date(now); d.setDate(now.getDate() + off);
    const wd = ((d.getDay() + 6) % 7) + 1;
    const slots = plan.filter((p) => p.weekday === wd).sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
    for (const p of slots) {
      const slot = slotStr(p);
      if (off === 0 && (doneToday.includes(slot) || nowMin > p.hour * 60 + (p.minute || 0) + 59)) continue;
      next = { date: todayStr(d), slot, type: p.type, typeLabel: TYPE_LABEL[p.type] || p.type, isToday: off === 0 };
      break;
    }
  }

  const qTotal = readLines(meta.questionsFile || '').filter((l) => !l.startsWith('#')).length;
  const qUsed = readLines(meta.questionsUsedFile || '').length;
  const snap = getLatestSnapshot();
  const top = (snap?.keywords || []).filter((k) => !k.err && k.n > 0)
    .sort((a, b) => (b.medLikes || 0) - (a.medLikes || 0)).slice(0, 3)
    .map((k) => ({ kw: k.kw, medLikes: k.medLikes || 0 }));

  return {
    ok: true, label: meta.label || '小红书自动化', icon: '🍠', enabled: meta.enabled,
    scanning: rm.scanning, lastError: rm.lastError, lastRunAt: rm.lastRunAt,
    today, next, last: meta.last || null,
    pool: { total: qTotal, used: Math.min(qUsed, qTotal), left: Math.max(0, qTotal - qUsed) },
    top, snapshotDate: snap?.date || null, hour: rm.hour,
  };
}

function readLines(f) { try { return readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean); } catch { return []; } }

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/page' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(PAGE_FILE));
      return;
    }
    if (url === '/api/xhs-radar' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ latest: getLatestSnapshot(), autopost: autopostMeta(), ...radarMeta() }));
      return;
    }
    if (url === '/api/xhs-radar/run' && req.method === 'POST') {
      runScan({ reason: 'manual' }).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, scanning: true }));
      return;
    }
    if (url === '/api/xhs-radar/autopost' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await postNow({ codex, visibility: b.visibility || '仅自己可见', type: b.type || 'question' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }
    if (url === '/api/xhs-radar/custom' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await postCustom({ codex, visibility: b.visibility || '公开可见', topic: b.topic || '', images: b.images || [] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }
    if (url === '/jobs/radar-scan' && req.method === 'POST') {
      if (getLatestSnapshot()?.date === todayStr()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, skipped: true, note: '今日已有榜单' }));
        return;
      }
      runScan({ reason: 'scheduled' }).catch((e) => console.error('[xhs] 定时扫描失败:', e.message));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true }));
      return;
    }
    if (url === '/indicator' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(indicator()));
      return;
    }
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'xhs' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error('[xhs] 处理失败:', err.message);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[xhs] 模块服务已启动 http://127.0.0.1:${PORT}`);
  startAutopost({ codex });
});
