import express from 'express';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CodexClient } from './codex-client.mjs';
import { startTtyd } from './terminal.mjs';
import { makeProxyServer } from './proxy.mjs';
import { runScan as xhsRunScan, getLatestSnapshot, radarMeta, startScheduler as startXhsRadar } from './xhs-radar.mjs';
import { autopostMeta, postNow as xhsPostNow, postCustom as xhsPostCustom, startAutopost } from './xhs-autopost.mjs';
import {
  CODEX_BIN, PORT, ACCESS_TOKEN, DEFAULT_CWD, DEFAULT_SANDBOX, DEFAULT_APPROVAL, DEFAULT_MODEL,
  TERMINAL_ENABLED, TTYD_PORT, TTYD_BASE, TMUX_SESSION, EXTRA_SERVICES, PINNED_SESSIONS, XHS_WORK_CWD, XHS_IMG_DIR,
} from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '80mb' }));

// ---------- helpers ----------
function getToken(req) {
  const auth = req.headers['authorization'] || '';
  let t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!t) { try { t = new URL(req.url, 'http://x').searchParams.get('token'); } catch {} }
  if (!t && req.headers.cookie) {
    const m = req.headers.cookie.match(/(?:^|;\s*)cm_token=([^;]+)/);
    if (m) t = decodeURIComponent(m[1]);
  }
  return t;
}
function auth(req, res, next) {
  if (getToken(req) !== ACCESS_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- codex app-server ----------
const codex = new CodexClient({ codexBin: CODEX_BIN });
codex.start().catch((err) => console.error('[codex] failed to start:', err.message));

const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch { sseClients.delete(res); } }
}
// 运行中会话跟踪（收到 turn 生命周期通知时维护）
const runningThreads = new Map(); // threadId -> 最近活动时间
const activeTurns = new Map();    // threadId -> 进行中的 turnId（turn/interrupt 需要 turnId）
function noteThreadActivity(m) {
  const p = m.params || {};
  const tid = p.threadId;
  if (!tid) return;
  // 只有「回合」（turn）生命周期才能代表任务真的在执行；
  // thread/status/changed 的 active 只表示会话被加载/挂载，不能当运行中。
  if (m.method === 'turn/started') {
    runningThreads.set(tid, Date.now());
    if (p.turn && p.turn.id) activeTurns.set(tid, p.turn.id);
  } else if (m.method === 'turn/completed' || m.method === 'turn/failed' || m.method === 'turn/interrupted') {
    runningThreads.delete(tid);
    activeTurns.delete(tid);
  } else if (m.method === 'thread/status/changed' && p.status && p.status.type === 'idle') {
    runningThreads.delete(tid); // 安全网：明确的空闲才清除
  }
}
codex.on('notification', (m) => { noteThreadActivity(m); broadcast('notification', m); });
codex.on('serverRequest', (m) => broadcast('serverRequest', m));
codex.on('status', (s) => { console.log('[codex]', s.state); broadcast('status', s); });
codex.on('raw', (l) => broadcast('raw', { line: l }));

// ---------- auth routes ----------
app.post('/api/login', (req, res) => {
  const { token } = req.body || {};
  if (token !== ACCESS_TOKEN) return res.status(401).json({ error: 'invalid token' });
  res.setHeader('Set-Cookie', `cm_token=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true, token });
});

app.get('/api/health', auth, (_req, res) => {
  res.json({ ok: true, codexReady: codex.ready, codexBin: CODEX_BIN, cwd: DEFAULT_CWD, terminal: TERMINAL_ENABLED, termBase: TTYD_BASE });
});

// ---------- SSE ----------
app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  sseClients.add(res);
  const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(keep); sseClients.delete(res); });
});

// ---------- models ----------
app.get('/api/models', auth, async (_req, res) => {
  try { await codex.ensureReady(); res.json(await codex.request('model/list', {})); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- projects ----------
app.get('/api/projects', auth, async (_req, res) => {
  try { await codex.ensureReady(); res.json(await codex.request('project/list', {})); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- external services config ----------
function probe(host, port, timeout = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

app.get('/api/services', auth, async (_req, res) => {
  const services = await Promise.all(EXTRA_SERVICES.map(async (s) => ({
    id: s.id, label: s.label, port: s.port, entry: s.entry,
    online: await probe(s.target.host, s.target.port),
  })));
  res.json({ services, pinned: PINNED_SESSIONS, running: [...runningThreads.keys()] });
});

app.get('/api/running', auth, (_req, res) => {
  res.json({ running: [...runningThreads.keys()] });
});

// ---------- 小红书热门雷达 ----------
app.get('/api/xhs-radar', auth, (_req, res) => {
  res.json({ latest: getLatestSnapshot(), cwd: XHS_WORK_CWD, autopost: autopostMeta(), ...radarMeta() });
});
app.post('/api/xhs-radar/run', auth, (_req, res) => {
  xhsRunScan({ reason: 'manual' }).catch(() => {});
  res.json({ ok: true, scanning: true });
});
app.post('/api/xhs-radar/autopost', auth, async (req, res) => {
  try {
    const visibility = (req.body && req.body.visibility) || '仅自己可见';
    const type = (req.body && req.body.type) || 'question';
    const r = await xhsPostNow({ codex, visibility, type });
    res.json({ ok: true, ...r });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// 自定义发帖：用户手填主题 + 可选上传图片（base64 dataURL）
app.post('/api/xhs-radar/custom', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const topic = String(b.topic || '');
    const visibility = b.visibility || '公开可见';
    const images = Array.isArray(b.images) ? b.images : [];
    if (!topic.trim() && !images.length) return res.status(400).json({ ok: false, error: '请填写内容或上传图片' });
    mkdirSync(XHS_IMG_DIR, { recursive: true });
    const stamp = Date.now();
    const saved = [];
    images.slice(0, 9).forEach((img, i) => {
      const m = String((img && img.dataUrl) || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) return;
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[m[1]]) || 'png';
      const name = `custom-${stamp}-${i}.${ext}`;
      try { writeFileSync(path.join(XHS_IMG_DIR, name), Buffer.from(m[2], 'base64')); saved.push(name); } catch {}
    });
    const r = await xhsPostCustom({ codex, visibility, topic, images: saved });
    res.json({ ok: true, ...r, images: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/loaded', auth, async (_req, res) => {
  try { await codex.ensureReady(); res.json(await codex.request('thread/loaded/list', { limit: 100 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- threads ----------
app.get('/api/threads', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    const params = { limit: Number(req.query.limit || 30), sortKey: req.query.sortKey || 'recency_at', sortDirection: req.query.sortDirection || 'desc' };
    if (req.query.search) params.searchTerm = String(req.query.search);
    if (req.query.archived === 'true') params.archived = true;
    if (req.query.sourceKinds) params.sourceKinds = String(req.query.sourceKinds).split(',').filter(Boolean);
    res.json(await codex.request('thread/list', params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/threads', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    const { cwd, model, sandbox, approvalPolicy } = req.body || {};
    res.json(await codex.request('thread/start', {
      cwd: cwd || DEFAULT_CWD, model: model || DEFAULT_MODEL || undefined,
      sandbox: sandbox || DEFAULT_SANDBOX, approvalPolicy: approvalPolicy || DEFAULT_APPROVAL,
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/threads/:id', auth, async (req, res) => {
  try { await codex.ensureReady(); res.json(await codex.request('thread/read', { threadId: req.params.id, includeTurns: false })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/threads/:id/turns', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    res.json(await codex.request('thread/turns/list', {
      threadId: req.params.id, limit: Number(req.query.limit || 50),
      sortDirection: req.query.sortDirection || 'asc', itemsView: req.query.itemsView || 'full',
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 把前端上传的 base64 图片落到本机临时文件，再用 localImage 传给 codex app-server
const UPLOAD_DIR = path.join(os.tmpdir(), 'codex-mobile-uploads');
function saveImages(images) {
  if (!Array.isArray(images) || !images.length) return [];
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const out = [];
  for (const img of images) {
    const raw = img?.dataUrl || img?.url || '';
    const m = /^data:([^;]+);base64,(.*)$/s.exec(raw);
    if (!m) continue;
    let ext = (m[1].split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
    if (ext === 'jpeg') ext = 'jpg';
    const file = path.join(UPLOAD_DIR, `${randomUUID()}.${ext}`);
    try { writeFileSync(file, Buffer.from(m[2], 'base64')); out.push({ type: 'localImage', path: file }); } catch {}
  }
  return out;
}

async function startTurn(threadId, body) {
  const { text, model, sandbox, approvalPolicy, images } = body || {};
  const input = [];
  if (text && String(text).trim()) input.push({ type: 'text', text, text_elements: [] });
  input.push(...saveImages(images));
  if (!input.length) input.push({ type: 'text', text: '', text_elements: [] });
  const params = {
    threadId, input,
    model: model || undefined, sandboxPolicy: sandbox ? { type: sandbox } : undefined, approvalPolicy: approvalPolicy || undefined,
  };
  try {
    try {
      return await codex.request('turn/start', params);
    } catch (e) {
      if (!/(thread not found|not loaded|unsubscribed|no such thread)/i.test(e.message || '')) throw e;
    }
    // existing (unloaded) threads must be resumed into this app-server first
    await codex.request('thread/resume', { threadId });
    return await codex.request('turn/start', params);
  } catch (err) {
    if (/active writer/i.test(err.message || '')) {
      const e = new Error('该会话正在电脑端使用中（写锁被占用）。');
      e.code = 'thread_locked';
      throw e;
    }
    throw err;
  }
}

app.post('/api/threads/:id/turns', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    const { text, images } = req.body || {};
    if (!text && !(Array.isArray(images) && images.length)) return res.status(400).json({ error: 'text or images required' });
    const r = await startTurn(req.params.id, req.body);
    if (r && r.turn && r.turn.id) activeTurns.set(req.params.id, r.turn.id);
    res.json(r);
  } catch (err) {
    if (err.code === 'thread_locked') return res.status(409).json({ error: 'thread_locked', message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/threads/:id/fork', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    const r = await codex.request('thread/fork', { threadId: req.params.id });
    const forkedThreadId = r.thread.id;
    const baseName = r.thread?.name || '';
    try { await codex.request('thread/name/set', { threadId: forkedThreadId, name: baseName ? `${baseName}（副本）` : '副本' }); } catch {}
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/threads/:id', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    try { await codex.request('thread/resume', { threadId: req.params.id }); } catch {}
    res.json(await codex.request('thread/delete', { threadId: req.params.id }));
  } catch (err) {
    if (/active writer/i.test(err.message || '')) return res.status(409).json({ error: 'thread_locked', message: '该会话正在电脑端使用中，请先关闭后再删除。' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/threads/:id/archive', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    res.json(await codex.request('thread/archive', { threadId: req.params.id }));
  } catch (err) {
    if (/active writer/i.test(err.message || '')) return res.status(409).json({ error: 'thread_locked', message: '该会话正在电脑端使用中，请先关闭后再归档。' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/threads/:id/interrupt', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    const threadId = req.params.id;
    // turn/interrupt 必须带 turnId：优先用通知/发起时记录的，其次回退查最新进行中的回合
    let turnId = activeTurns.get(threadId);
    if (!turnId) {
      try {
        const r = await codex.request('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc', itemsView: 'full' });
        const list = r.data || [];
        const act = list.find((t) => t.status === 'inProgress');
        turnId = act ? act.id : undefined;
      } catch {}
    }
    if (!turnId) return res.status(409).json({ error: 'no_active_turn', message: '该会话当前没有进行中的回合' });
    const out = await codex.request('turn/interrupt', { threadId, turnId });
    activeTurns.delete(threadId);
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/respond', auth, (req, res) => {
  const { id, result, error } = req.body || {};
  if (id === undefined) return res.status(400).json({ error: 'id required' });
  if (error) codex.respondError(id, error.code ?? -32000, error.message ?? 'error');
  else codex.respond(id, result ?? {});
  res.json({ ok: true });
});

// ---------- terminal reverse proxy (http + websocket) ----------
const TTY = { host: '127.0.0.1', port: TTYD_PORT };
function proxyHttp(req, res) {
  const opts = { host: TTY.host, port: TTY.port, method: req.method, path: req.url,
    headers: { ...req.headers, host: `${TTY.host}:${TTY.port}` } };
  const pr = http.request(opts, (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); });
  pr.on('error', () => { try { res.writeHead(502); } catch {} res.end('terminal unavailable'); });
  req.pipe(pr);
}
function proxyUpgrade(req, socket, head) {
  const opts = { host: TTY.host, port: TTY.port, method: req.method, path: req.url,
    headers: { ...req.headers, host: `${TTY.host}:${TTY.port}` } };
  const pr = http.request(opts);
  pr.on('upgrade', (pres, psocket, phead) => {
    const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage || 'Switching Protocols'}`];
    for (const [k, v] of Object.entries(pres.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (phead && phead.length) socket.unshift(phead);
    psocket.pipe(socket); socket.pipe(psocket);
    if (head && head.length) psocket.write(head);
    psocket.on('error', () => socket.destroy());
    socket.on('error', () => psocket.destroy());
  });
  pr.on('error', () => socket.destroy());
  pr.end();
}
if (TERMINAL_ENABLED) {
  startTtyd({ port: TTYD_PORT, basePath: TTYD_BASE, session: TMUX_SESSION });
  app.use((req, res, next) => {
    if (req.path === TTYD_BASE || req.path.startsWith(TTYD_BASE + '/')) {
      return auth(req, res, () => proxyHttp(req, res));
    }
    next();
  });
}

// ---------- static web build ----------
// ---------- 本地图片（Markdown 里引用的本机绝对路径，只读）----------
const IMG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon',
};
const IMG_ROOTS = [os.homedir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
app.get('/api/localimage', auth, (req, res) => {
  let p = String(req.query.path || '').trim();
  if (!p) return res.status(400).json({ error: 'path required' });
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  const abs = path.resolve(p);
  const ext = path.extname(abs).toLowerCase();
  if (!IMG_MIME[ext]) return res.status(415).json({ error: 'unsupported image type' });
  if (!IMG_ROOTS.some((r) => abs === r || abs.startsWith(r + path.sep))) return res.status(403).json({ error: 'path not allowed' });
  const stream = createReadStream(abs);
  stream.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'not found' }); else res.end(); });
  res.setHeader('Content-Type', IMG_MIME[ext]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=120');
  stream.pipe(res);
});

const webDist = path.join(__dirname, '..', 'web', 'dist');
if (existsSync(webDist)) {
  // HTML 永不缓存（避免发版后旧 index.html 指向已删除的旧 bundle 导致白屏）；
  // 带内容哈希的 /assets 可长期强缓存。
  app.use(express.static(webDist, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  const spa = /^(?!\/(api|term)).*/;
  app.get(spa, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// ---------- server ----------
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (TERMINAL_ENABLED && req.url.startsWith(TTYD_BASE)) {
    if (getToken(req) !== ACCESS_TOKEN) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    return proxyUpgrade(req, socket, head);
  }
  socket.destroy();
});
// ---------- 1:1 proxies for local services ----------
for (const svc of EXTRA_SERVICES) {
  const s = makeProxyServer({ target: svc.target, checkAuth: (req) => getToken(req) === ACCESS_TOKEN });
  s.listen(svc.port, '0.0.0.0', () => {
    console.log(`[svc] ${svc.label}: 0.0.0.0:${svc.port}${svc.entry} -> ${svc.target.host}:${svc.target.port}`);
  });
  s.on('error', (err) => console.error(`[svc] ${svc.label} failed:`, err.message));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`codex-mobile server on http://0.0.0.0:${PORT}`);
  console.log(`codex bin: ${CODEX_BIN}`);
  console.log(`terminal: ${TERMINAL_ENABLED ? `${TTYD_BASE}/ -> 127.0.0.1:${TTYD_PORT} (tmux: ${TMUX_SESSION})` : 'disabled'}`);
  console.log(`access token: ${ACCESS_TOKEN}`);
});

startXhsRadar();
startAutopost({ codex });

// ---------- graceful shutdown（避免热重启/退出时残留 app-server 子进程）----------
let _shuttingDown = false;
function shutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[server] ${sig} received, shutting down…`);
  try { codex.stop(); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => { try { codex.stop(); } catch {} });
