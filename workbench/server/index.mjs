import express from 'express';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, createReadStream, statSync, readdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CodexClient } from './codex-client.mjs';
import { startTtyd } from './terminal.mjs';
import { makeProxyServer } from './proxy.mjs';
import { todayData, noteTokenUsage } from './today.mjs';
import { scanModules, listModules, setEnabled, proxyModule, stdioRoute, tickJobs, refreshIndicators, getModule, killAllStdio, jobRecords, mcpEndpoint } from './modules.mjs';
import {
  CODEX_BIN, PORT, ACCESS_TOKEN, DEFAULT_CWD, DEFAULT_SANDBOX, DEFAULT_APPROVAL, DEFAULT_MODEL,
  TERMINAL_ENABLED, TTYD_PORT, TTYD_BASE, TMUX_SESSION, EXTRA_SERVICES, PINNED_SESSIONS,
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
codex.on('notification', (m) => { noteThreadActivity(m); if (m.method === 'thread/tokenUsage/updated') noteTokenUsage(m); broadcast('notification', m); });
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

// 路径规整：支持 ~ 与相对路径，返回绝对路径字符串
function normalizeProjectPath(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

function isDirectory(abs) {
  try { return statSync(abs).isDirectory(); } catch { return false; }
}

// 新建项目（对应电脑端客户端的项目列表，走 app-server project/create）
app.post('/api/projects', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    const { name, path: rawPath } = req.body || {};
    const dir = normalizeProjectPath(rawPath);
    if (!dir) return res.status(400).json({ error: 'bad_request', message: '请填写项目根目录' });
    if (!isDirectory(dir)) return res.status(400).json({ error: 'bad_request', message: `目录不存在或不是文件夹：${dir}` });
    const nm = String(name || '').trim() || dir.split(path.sep).filter(Boolean).pop() || '';
    if (!nm) return res.status(400).json({ error: 'bad_request', message: '项目名称不能为空' });
    const r = await codex.request('project/create', { name: nm, roots: [{ path: dir }], idempotencyKey: randomUUID() });
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 编辑项目：改名（name）和/或更换根目录（path）
app.patch('/api/projects/:id', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    const { name, path: rawPath } = req.body || {};
    const params = { projectId: req.params.id };
    if (name !== undefined) {
      const nm = String(name).trim();
      if (!nm) return res.status(400).json({ error: 'bad_request', message: '项目名称不能为空' });
      params.name = nm;
    }
    if (rawPath !== undefined) {
      const dir = normalizeProjectPath(rawPath);
      if (!dir) return res.status(400).json({ error: 'bad_request', message: '请填写项目根目录' });
      if (!isDirectory(dir)) return res.status(400).json({ error: 'bad_request', message: `目录不存在或不是文件夹：${dir}` });
      params.roots = [{ path: dir }];
    }
    res.json(await codex.request('project/update', params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 删除项目：只解除分组，项目下的会话不会被删除
app.delete('/api/projects/:id', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    res.json(await codex.request('project/delete', { projectId: req.params.id }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 浏览主目录下的文件夹（项目选择器用）：默认主目录，只能浏览 home 子树，不显示隐藏目录
app.get('/api/fs', auth, (req, res) => {
  const home = os.homedir();
  let p = normalizeProjectPath(req.query.path) || home;
  try { p = realpathSync(p); } catch { return res.status(400).json({ error: 'bad_request', message: `目录不存在：${p}` }); }
  if (p !== home && !p.startsWith(home + path.sep)) {
    return res.status(403).json({ error: 'forbidden', message: '只能浏览用户主目录下的文件夹' });
  }
  let dirs = [];
  try {
    dirs = readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  } catch (err) { return res.status(500).json({ error: err.message }); }
  res.json({ path: p, name: path.basename(p), home, parent: p === home ? null : path.dirname(p), dirs });
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

// ---------- 今日一屏 ----------
app.get('/api/today', auth, async (_req, res) => {
  try { res.json(await todayData({ codex, running: [...runningThreads.keys()] })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- 模块宿主（firefly 式：modules/<id>/module.json，HTTP 型模块由安装者独立运行） ----------
app.get('/api/modules', auth, async (_req, res) => {
  await refreshIndicators().catch(() => {});
  res.json({ modules: listModules() });
});
app.post('/api/modules/rescan', auth, (_req, res) => {
  scanModules();
  refreshIndicators().catch(() => {});
  res.json({ ok: true, modules: listModules() });
});
app.post('/api/modules/:id/toggle', auth, (req, res) => {
  const ok = setEnabled(req.params.id, !!(req.body && req.body.enabled));
  refreshIndicators().catch(() => {});
  res.json({ ok, modules: listModules() });
});
app.get('/api/modules/:id/jobs', auth, (req, res) => {
  res.json({ jobs: jobRecords(req.params.id) });
});
// 聚合 MCP 端点（streamable HTTP，Bearer 鉴权）：Codex 对话由此调用启用模块的工具
app.post('/mcp', auth, (req, res) => { mcpEndpoint(req, res).catch((e) => { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e.message || e) } }); }); });
// 模块页面/API 统一代理：/m/<id>/<子路径> → http 模块代理或 stdio 模块路由（仅启用模块）
app.use('/m/:id', auth, (req, res) => {
  const mod = getModule(req.params.id);
  if (!mod || !mod.enabled) return res.status(403).json({ error: '模块未启用' });
  if (mod.transport === 'stdio') stdioRoute(mod, req, res, req.url).catch((e) => { console.error('[modules] stdioRoute 异常:', e); if (!res.headersSent) res.status(500).json({ error: e.message }); });
  else proxyModule(mod, req, res, req.url);
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
    // sandbox/approvalPolicy 仅在显式给出（body 或环境变量）时才传；
    // 省略时 app-server 按 ~/.codex/config.toml 的默认值建会话，与电脑端客户端同权限。
    res.json(await codex.request('thread/start', {
      cwd: cwd || DEFAULT_CWD, model: model || DEFAULT_MODEL || undefined,
      sandbox: sandbox || DEFAULT_SANDBOX || undefined,
      approvalPolicy: approvalPolicy || DEFAULT_APPROVAL || undefined,
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
  const { id, result, error, method } = req.body || {};
  if (id === undefined) return res.status(400).json({ error: 'id required' });
  if (error) codex.respondError(id, error.code ?? -32000, error.message ?? 'error');
  else codex.respond(id, result ?? {}, method);
  res.json({ ok: true });
});

// ---------- 会话权限（对标电脑端客户端的三档选择器） ----------
const PERM_SANDBOX_POLICIES = {
  'workspace-write': { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  'danger-full-access': { type: 'dangerFullAccess' },
  'read-only': { type: 'readOnly' },
};
const PERM_PRESETS = {
  ask:  { approvalPolicy: 'untrusted', sandboxPolicy: PERM_SANDBOX_POLICIES['workspace-write'] },
  auto: { approvalPolicy: 'on-request', sandboxPolicy: PERM_SANDBOX_POLICIES['workspace-write'] },
  full: { approvalPolicy: 'never', sandboxPolicy: PERM_SANDBOX_POLICIES['danger-full-access'] },
};
// 「跟随客户端」的值 = ~/.codex/config.toml 里用户自己定的默认权限
function codexConfigPerm() {
  try {
    const t = readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const grab = (k) => { const m = t.match(new RegExp('^' + k + '\\s*=\\s*"([^"]+)"', 'm')); return m ? m[1] : null; };
    return { sandbox: grab('sandbox_mode') || 'workspace-write', approval: grab('approval_policy') || 'never' };
  } catch { return { sandbox: 'workspace-write', approval: 'never' }; }
}

app.post('/api/threads/:id/settings', auth, async (req, res) => {
  try {
    await codex.ensureReady();
    const mode = (req.body && req.body.mode) || 'follow';
    let params;
    if (mode === 'follow') {
      const cfg = codexConfigPerm();
      params = { approvalPolicy: cfg.approval, sandboxPolicy: PERM_SANDBOX_POLICIES[cfg.sandbox] || PERM_SANDBOX_POLICIES['workspace-write'] };
    } else {
      const p = PERM_PRESETS[mode];
      if (!p) return res.status(400).json({ error: '未知权限模式' });
      params = p;
    }
    const payload = { threadId: req.params.id, ...params };
    try {
      await codex.request('thread/settings/update', payload);
    } catch (e) {
      if (/not found|not loaded|unsubscribed|no such thread/i.test(e.message || '')) {
        await codex.request('thread/resume', { threadId: req.params.id });
        await codex.request('thread/settings/update', payload);
      } else { throw e; }
    }
    res.json({ ok: true, mode, applied: params });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
// 安卓 App 安装包（Capacitor 构建产物，手机浏览器带令牌直接下载安装）
const APK_PATH = path.join(__dirname, '..', '..', 'workbench-app', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
app.get('/apk/app-debug.apk', auth, (req, res) => {
  if (!existsSync(APK_PATH)) return res.status(404).json({ error: 'APK 未构建，先跑 gradlew assembleDebug' });
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="workbench.apk"');
  createReadStream(APK_PATH).pipe(res);
});
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

// —— 模块宿主启动：扫描 + jobs 调度器（不重叠/不补齐/逾期合并一次）+ indicator 轮询 ——
scanModules();
setInterval(() => { tickJobs().catch(() => {}); }, 20 * 1000).unref?.();
setInterval(() => { refreshIndicators().catch(() => {}); }, 5 * 60 * 1000).unref?.();
refreshIndicators().catch(() => {});

// ---------- graceful shutdown（避免热重启/退出时残留 app-server 子进程）----------
let _shuttingDown = false;
function shutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[server] ${sig} received, shutting down…`);
  try { killAllStdio(); } catch {}
  try { codex.stop(); } catch {}
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 2000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => { try { killAllStdio(); } catch {} try { codex.stop(); } catch {} });
