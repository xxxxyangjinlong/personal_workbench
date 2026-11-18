// 模块宿主：扫描 modules/、启用存档、页面代理、jobs 调度、indicator 聚合
// 支持两种清单：
//   1) module.json（workbench 原生）：transport http（REST 页面/API，原样代理）或 stdio（command/args）
//   2) module.toml（Firefly 格式，@iarna/toml 解析）：stdio MCP 或 streamable_http（http-mcp v1 不支持）
// 语义参照 firefly（42tr/firefly）：HTTP 型模块由安装者独立运行，宿主不拉起；
// stdio 型模块由宿主拉起（MCP over stdin/stdout，env 白名单注入）；
// 定时任务不重叠、离线错过合并一次、执行记录每模块留 100 条；模块数据目录独立。
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from '@iarna/toml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.join(__dirname, '..', 'modules');
const STATE_FILE = path.join(__dirname, '..', 'data', 'modules.json');
const JOBS_FILE = path.join(__dirname, '..', 'data', 'module-jobs.json');
const DATA_MODULES_DIR = path.join(__dirname, '..', 'data', 'modules');

function loadJson(f, fallback) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } }
function saveJson(f, obj) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(obj, null, 1)); }

let registry = {};          // id -> 规范化清单 + { dir, dataDir, enabled }
const indicatorCache = {};  // id -> 最近一次 indicator 或 { offline: true }

// —— Firefly module.toml → 规范化清单 ——
function normalizeFirefly(t) {
  const mcp = t.mcp || {};
  const transport = mcp.transport === 'stdio' ? 'stdio' : (mcp.transport === 'streamable_http' ? 'http-mcp' : null);
  if (!transport) throw new Error(`不支持的 mcp.transport: ${mcp.transport}`);
  if (transport === 'http-mcp') throw new Error('streamable_http 型模块 v1 暂不支持');
  return {
    id: t.id, name: t.name, version: t.version || '0.0.0', description: t.description || '',
    icon: null,
    transport,
    command: mcp.command,
    args: mcp.args || [],
    env: mcp.env || {},
    envFrom: mcp.env_from || {},
    callTimeoutSecs: t.call_timeout_secs || 120,
    allowedTools: t.allowed_tools || null,
    configSchema: t.config_schema || null,
    pages: (t.pages || []).map((p) => ({ id: p.id, title: p.title, path: '/page', openTool: p.open_tool || null, arguments: p.arguments || {}, icon: p.icon || null })),
    jobs: (t.jobs || []).map((j) => ({ id: j.id, tool: j.tool, arguments: j.arguments || {}, cron: j.cron, tz: j.timezone || 'Asia/Shanghai', enabledByDefault: !!j.enabled_by_default, path: null })),
    indicator: t.indicator ? { tool: t.indicator.tool, refresh: t.indicator.refresh_secs || 60, arguments: t.indicator.arguments || {} } : null,
  };
}

function scanDir(dirName) {
  const dir = path.join(MODULES_DIR, dirName);
  let m = null;
  const jsonPath = path.join(dir, 'module.json');
  const tomlPath = path.join(dir, 'module.toml');
  if (existsSync(jsonPath)) {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
    m = { ...j };
  } else if (existsSync(tomlPath)) {
    m = normalizeFirefly(parseToml(readFileSync(tomlPath, 'utf8')));
  } else return null;
  if (!m.id) throw new Error('清单缺少 id');
  // 注：firefly 不要求目录名 = id（data 目录按 id 建），这里同样放宽；重复 id 在 scanModules 里统一剔除
  if (m.transport !== 'http' && m.transport !== 'stdio') throw new Error(`不支持的 transport: ${m.transport}`);
  if (m.transport === 'http' && !m.baseUrl) throw new Error('http 模块缺少 baseUrl');
  if (m.transport === 'stdio' && !m.command) throw new Error('stdio 模块缺少 command');
  m.dir = dir;
  m.dataDir = path.join(DATA_MODULES_DIR, dirName);
  return m;
}

let stateDirty = false;
export function scanModules() {
  const st = loadJson(STATE_FILE, {});
  const out = {};
  if (!existsSync(MODULES_DIR)) mkdirSync(MODULES_DIR, { recursive: true });
  const found = [];
  for (const dirName of readdirSync(MODULES_DIR)) {
    try {
      const m = scanDir(dirName);
      if (!m) continue;
      found.push(m);
    } catch (e) { console.error(`[modules] 清单无效，跳过 ${dirName}: ${e.message}`); }
  }
  // firefly 语义：同 ID 模块均不加载
  const dupIds = new Set(found.filter((m, i) => found.findIndex((x) => x.id === m.id) !== i).map((m) => m.id));
  for (const m of found) {
    if (dupIds.has(m.id)) { console.error(`[modules] 模块 ID 重复，均不加载: ${m.id}`); continue; }
    out[m.id] = { ...m, enabled: !!(st[m.id] && st[m.id].enabled) };
  }
  // 清单变化/移除的 stdio 模块：停掉旧进程
  for (const id of Object.keys(stdio)) {
    const cur = out[id];
    const old = registry[id];
    if (!cur || !old || cur.transport !== 'stdio' || JSON.stringify({ c: cur.command, a: cur.args, e: cur.env, v: cur.version }) !== JSON.stringify({ c: old.command, a: old.args, e: old.env, v: old.version })) {
      stopStdio(id);
    }
  }
  registry = out;
  return out;
}

export function listModules() {
  return Object.values(registry).map((m) => ({
    id: m.id, name: m.name, version: m.version, icon: m.icon || '🧩',
    description: m.description || '', enabled: m.enabled,
    online: indicatorCache[m.id] ? !indicatorCache[m.id].offline : null,
    pages: (m.pages || []).map((p) => ({ ...p, url: `/m/${m.id}${p.path}` })),
    jobs: (m.jobs || []).map((j) => ({ ...j, record: (JOBS_STATE[`${m.id}|${j.id}`] || {}).lastStatus || null })),
    indicator: indicatorCache[m.id] || null,
  }));
}

export function setEnabled(id, enabled) {
  if (!registry[id]) return false;
  const st = loadJson(STATE_FILE, {});
  st[id] = { ...(st[id] || {}), enabled };
  saveJson(STATE_FILE, st);
  registry[id].enabled = enabled;
  if (!enabled) stopStdio(id); // 停用撤销句柄、关闭连接（firefly 语义）
  return true;
}

export function getModule(id) { return registry[id] || null; }
export function modulePageUrl(id) {
  const m = registry[id];
  return m && m.enabled && m.pages && m.pages.length ? `/m/${id}${m.pages[0].path}` : null;
}
export function getIndicator(id) { return indicatorCache[id] || { offline: true }; }

export function probeOnline(mod) {
  if (mod.transport === 'stdio') {
    const st = stdio[mod.id];
    return Promise.resolve(!!(st && st.proc && !st.stopped));
  }
  return new Promise((resolve) => {
    try {
      const u = new URL(mod.baseUrl);
      const sock = net.connect({ host: u.hostname, port: Number(u.port) || 80 });
      let done = false;
      const fin = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
      sock.setTimeout(1500);
      sock.once('connect', () => fin(true));
      sock.once('timeout', () => fin(false));
      sock.once('error', () => fin(false));
    } catch { resolve(false); }
  });
}

// —— stdio MCP 进程管理 ——
const stdio = {}; // id -> { proc, buf, pending, nextId, tools, stopped }
const SPAWN_FAILS = {}; // id -> { ts, msg }，跨进程生命周期记启动失败

function stopStdio(id) {
  const st = stdio[id];
  if (st) { st.stopped = true; try { st.proc && st.proc.kill(); } catch {} delete stdio[id]; }
}

function stdioEnsure(mod) {
  let st = stdio[mod.id];
  if (st && st.proc && !st.stopped) return st.starting || Promise.resolve();
  // 失败冷却：启动失败后 15 秒内不重复 spawn，避免轮询风暴（独立于进程生命周期记录）
  const fail = SPAWN_FAILS[mod.id];
  if (fail && Date.now() - fail.ts < 15000) return Promise.reject(new Error(fail.msg || '模块启动失败，冷却中'));
  stopStdio(mod.id);
  mkdirSync(mod.dataDir, { recursive: true });
  st = { proc: null, buf: '', pending: new Map(), nextId: 1, tools: null, stopped: false };
  stdio[mod.id] = st;
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    HOME: process.env.HOME,
    LANG: process.env.LANG || 'zh_CN.UTF-8',
    ...Object.fromEntries(Object.entries(mod.envFrom || {}).map(([k, src]) => [k, process.env[src]]).filter(([, v]) => v !== undefined)),
    ...(mod.env || {}),
    FIREFLY_MODULE_DATA_DIR: mod.dataDir,
    WORKBENCH_MODULE_DATA_DIR: mod.dataDir,
    FIREFLY_MODULE_CONFIG: '{}',
    WORKBENCH_MODULE_CONFIG: '{}',
    FIREFLY_MODULE_TIMEZONE: 'Asia/Shanghai',
    WORKBENCH_MODULE_TIMEZONE: 'Asia/Shanghai',
  };
  const proc = spawn(mod.command, mod.args || [], { cwd: mod.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  st.proc = proc;
  proc.stderr.on('data', (d) => { try { appendStderr(mod.id, d.toString()); } catch {} });
  proc.stdout.on('data', (chunk) => {
    st.buf += chunk.toString('utf8');
    let idx;
    while ((idx = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, idx).trim();
      st.buf = st.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null && st.pending.has(msg.id)) {
          const p = st.pending.get(msg.id);
          st.pending.delete(msg.id);
          clearTimeout(p.timer);
          msg.error ? p.reject(new Error(msg.error.message || 'MCP 错误')) : p.resolve(msg.result);
        }
      } catch {}
    }
  });
  proc.on('exit', () => {
    st.stopped = true;
    for (const p of st.pending.values()) { clearTimeout(p.timer); p.reject(new Error('模块进程已退出')); }
    st.pending.clear();
    if (stdio[mod.id] === st) delete stdio[mod.id];
  });
  proc.on('error', (e) => { SPAWN_FAILS[mod.id] = { ts: Date.now(), msg: `进程错误: ${e.message}` }; console.error(`[modules] ${mod.id} 进程错误:`, e.message); });
  st.starting = new Promise((resolve, reject) => {
    const t = setTimeout(() => { SPAWN_FAILS[mod.id] = { ts: Date.now(), msg: 'MCP 初始化超时' }; reject(new Error('MCP 初始化超时')); }, 10000);
    stdioRpcOnce(mod, st, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'workbench', version: '1.0.0' } }, 10000)
      .then(() => {
        try { st.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch {}
        clearTimeout(t); resolve();
      })
      .catch((e) => { clearTimeout(t); SPAWN_FAILS[mod.id] = { ts: Date.now(), msg: String(e.message || e) }; reject(e); });
  });
  return st.starting;
}

const STDERR_TAILS = {};
function appendStderr(id, text) {
  STDERR_TAILS[id] = ((STDERR_TAILS[id] || '') + text).slice(-2000);
  try {
    const mod = registry[id];
    if (mod && mod.dataDir) { mkdirSync(mod.dataDir, { recursive: true }); writeFileSync(path.join(mod.dataDir, 'stderr.log'), (STDERR_TAILS[id] || ''), { flag: 'w' }); }
  } catch {}
}

function stdioRpcOnce(mod, st, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = st.nextId++;
    const timer = setTimeout(() => { st.pending.delete(id); reject(new Error(`MCP 调用超时: ${method}`)); }, timeoutMs);
    st.pending.set(id, { resolve, reject, timer });
    st.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
  });
}

async function stdioRpc(mod, method, params, timeoutMs) {
  await stdioEnsure(mod);
  const st = stdio[mod.id];
  if (!st || !st.proc) throw new Error('模块进程未运行');
  return stdioRpcOnce(mod, st, method, params, timeoutMs ?? (mod.callTimeoutSecs || 120) * 1000);
}

async function stdioCallTool(mod, name, args) {
  if (mod.allowedTools && !mod.allowedTools.includes(name)) throw new Error(`工具 ${name} 不在该模块允许清单内`);
  return stdioRpc(mod, 'tools/call', { name, arguments: args || {} });
}

// —— 统一操作（按 transport 分派）——
async function moduleCallTool(mod, name, args) {
  if (mod.transport === 'stdio') return stdioCallTool(mod, name, args);
  throw new Error('http 型模块不支持工具调用');
}
async function moduleIndicator(mod) {
  if (!mod.indicator) return { ok: true, online: true };
  if (mod.transport === 'stdio') {
    const r = await stdioCallTool(mod, mod.indicator.tool, mod.indicator.arguments || {});
    return { ok: true, ...(r.structuredContent || {}), indicator: r.structuredContent?.indicator ?? null };
  }
  throw new Error('http 模块 indicator 走 GET 代理');
}
async function modulePageHtml(mod, page) {
  if (mod.transport === 'http') return null; // http 模块页面走代理，不经此函数
  // firefly 语义：open_tool 的定义（tools/list）携带 _meta.ui.resourceUri；页面 HTML 经 resources/read 取回
  const tl = await stdioRpc(mod, 'tools/list', {});
  const tool = (tl.tools || []).find((t) => t.name === page.openTool);
  if (!tool) throw new Error(`页面入口工具不存在: ${page.openTool}`);
  const uri = tool._meta?.ui?.resourceUri;
  if (!uri || !String(uri).startsWith('ui://')) throw new Error('工具没有 MCP Apps 页面资源');
  const rr = await stdioRpc(mod, 'resources/read', { uri });
  const c = (rr.contents || []).find((x) => x.uri === uri) || (rr.contents || [])[0];
  if (!c) throw new Error('页面资源缺失');
  if (c.mimeType && !String(c.mimeType).startsWith('text/html')) throw new Error(`页面资源类型异常: ${c.mimeType}`);
  return c.blob ? Buffer.from(c.blob, 'base64').toString('utf8') : c.text;
}

export async function refreshIndicators() {
  for (const m of Object.values(registry)) {
    if (!m.enabled) { indicatorCache[m.id] = { offline: true }; continue; }
    try {
      if (m.transport === 'http') {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(m.baseUrl + (m.indicator?.path || '/indicator'), { signal: ctl.signal });
        clearTimeout(t);
        indicatorCache[m.id] = await r.json();
      } else if (m.indicator) {
        const r = await stdioCallTool(m, m.indicator.tool, m.indicator.arguments || {});
        indicatorCache[m.id] = { ok: true, ...(r.structuredContent || {}) };
      } else {
        // 预热：启用中的 stdio 模块拉起进程并完成 MCP 握手（firefly 语义：chat/UI/schedules 共享一条连接）
        const online = await stdioEnsure(m).then(() => true).catch(() => false);
        indicatorCache[m.id] = online ? { ok: true } : { offline: true };
      }
    } catch (e) { indicatorCache[m.id] = { offline: true, error: String(e.message || e).slice(0, 160) }; }
  }
}

// —— http 模块代理（原样）——
export function proxyModule(mod, req, res, subPath) {
  try {
    const u = new URL(mod.baseUrl);
    const payload = ['GET', 'HEAD'].includes(req.method) ? null : JSON.stringify(req.body ?? {});
    const opts = {
      hostname: u.hostname, port: Number(u.port) || 80, method: req.method,
      path: (u.pathname.replace(/\/$/, '') || '') + subPath,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    };
    const pr = http.request(opts, (pr2) => { res.writeHead(pr2.statusCode || 502, pr2.headers); pr2.pipe(res); });
    pr.on('error', () => { if (!res.headersSent) res.status(503).json({ error: '模块离线' }); else res.end(); });
    if (payload) pr.write(payload);
    pr.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}

// —— stdio 模块的路由（页面 = iframe 包装 + MCP Apps 桥；REST = tools/rpc）——
export async function stdioRoute(mod, req, res, subPath) {
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  // subPath 可能带 query（req.url 原样传入），分支判断前剥离；query 在需要时透传
  const qIdx = subPath.indexOf('?');
  const query = qIdx >= 0 ? subPath.slice(qIdx) : '';
  const route = qIdx >= 0 ? subPath.slice(0, qIdx) : subPath;
  if (route === '/page' && req.method === 'GET') {
    if (!mod.pages || !mod.pages.length) { send(404, 'application/json', JSON.stringify({ error: '该模块没有页面' })); return; }
    // URL 必须带 /m/<id> 前缀（iframe src 是相对 wrapper 文档解析的）；透传 query（含 token）
    const base = '/m/' + mod.id;
    const openTool = JSON.stringify(mod.pages[0].openTool || '');
    const openArgs = JSON.stringify((mod.pages[0].arguments) || {});
    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(mod.name)}</title><style>html{--safe-top:env(safe-area-inset-top,0px);--back-gap:10px}html.native{--back-gap:34px}html,body{margin:0;height:100%;background:#0e1116}body{display:flex;flex-direction:column}#bar{display:none;flex:0 0 auto;align-items:center;padding:max(var(--safe-top),var(--back-gap)) 10px 8px;background:#f8fafc;border-bottom:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(15,23,42,.05)}#bar.on{display:flex}#back{-webkit-tap-highlight-color:transparent;touch-action:manipulation;display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:92px;font:15px -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;color:#1f2937;background:transparent;border:0;border-radius:10px;padding:10px 16px;cursor:pointer}#back:hover{background:#e8eef5}#back:active{background:#dde5ee}iframe{flex:1;min-height:0;width:100%;border:0;display:block}</style></head><body><div id="bar"><button id="back" type="button" aria-label="返回">← 返回</button></div><iframe id="f" src="${esc(base + '/raw-page' + query)}"></iframe><script>
const bar=document.getElementById('bar'),back=document.getElementById('back');
const ua=navigator.userAgent;const nativeApp=!!window.Capacitor||(ua.indexOf('Android')>=0&&ua.indexOf('wv')>=0);
if(nativeApp)document.documentElement.classList.add('native');
if(window.self===window.top){bar.classList.add('on');const goBack=()=>{const t=new URLSearchParams(location.search).get('token');const home='/'+(t?'?token='+encodeURIComponent(t):'');if(history.length>1)history.back();else location.href=home;};back.onclick=(e)=>{e.stopPropagation();goBack();};bar.onclick=goBack;}
const f=document.getElementById('f');
const RPC='${base}/rpc${query}';
const OPEN_TOOL=${openTool};
const OPEN_ARGS=${openArgs};
let pageReady=false;
async function callTool(name,args){
  const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name,arguments:args||{}}})});
  const j=await r.json();
  if(j.error)throw new Error(j.error.message||'模块调用失败');
  return j.result;
}
window.addEventListener('message',async(e)=>{
  if(e.source!==f.contentWindow)return;
  const m=e.data;
  if(!m||m.jsonrpc!=='2.0'||typeof m.method!=='string')return;
  const reply=(result)=>f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
  const fail=(msg)=>f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:msg}},'*');
  if(m.method==='ui/initialize'){
    reply({protocolVersion:'2026-01-26',hostInfo:{name:'workbench',version:'1.0.0'},hostCapabilities:{serverTools:{}},hostContext:{origin:location.origin}});
    return;
  }
  if(m.method==='ui/notifications/initialized'){
    // firefly 语义：页面就绪后由宿主调 open_tool 并推送初始数据
    if(pageReady)return; pageReady=true;
    try{
      const result=await callTool(OPEN_TOOL,OPEN_ARGS);
      f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:OPEN_ARGS}},'*');
      f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result},'*');
    }catch(err){
      f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{isError:true,content:[{type:'text',text:String(err.message||err)}]}},'*');
    }
    return;
  }
  if(m.method==='tools/call'||m.method==='resources/read'||m.method==='ping'){
    try{
      const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:m.method,params:m.params||{}})});
      const j=await r.json();
      j.error?fail(j.error.message||'模块调用失败'):reply(j.result);
    }catch(err){fail(String(err.message||err));}
    return;
  }
  if(m.id!==undefined&&m.id!==null){fail('此宿主尚未支持该能力');}
});
</script></body></html>`;
    send(200, 'text/html; charset=utf-8', html);
    return;
  }
  if (route === '/raw-page' && req.method === 'GET') {
    const page = (mod.pages || [])[0];
    if (!page || !page.openTool) { send(404, 'application/json', JSON.stringify({ error: '该模块没有页面' })); return; }
    modulePageHtml(mod, page)
      .then((html) => send(200, 'text/html; charset=utf-8', html))
      .catch((e) => send(500, 'application/json', JSON.stringify({ error: e.message })));
    return;
  }
  if (route === '/rpc' && req.method === 'POST') {
    const b = (req.body && typeof req.body === 'object' && Object.keys(req.body).length) ? req.body : await readBody(req);
    const method = String(b.method || '');
    if (!['tools/call', 'resources/read', 'ping'].includes(method)) { send(400, 'application/json', JSON.stringify({ error: '不允许的方法' })); return; }
    if (method === 'tools/call' && mod.allowedTools && !mod.allowedTools.includes(b.params?.name)) { send(403, 'application/json', JSON.stringify({ error: `工具 ${b.params?.name} 不在允许清单内` })); return; }
    stdioRpc(mod, method, b.params || {})
      .then((result) => send(200, 'application/json', JSON.stringify({ result })))
      .catch((e) => send(500, 'application/json', JSON.stringify({ error: e.message })));
    return;
  }
  if (route === '/tools' && req.method === 'GET') {
    stdioRpc(mod, 'tools/list', {})
      .then((r) => send(200, 'application/json', JSON.stringify({ tools: r.tools || [] })))
      .catch((e) => send(500, 'application/json', JSON.stringify({ error: e.message })));
    return;
  }
  const toolCall = /^\/tools\/([A-Za-z0-9_.-]+)$/.exec(route);
  if (toolCall && req.method === 'POST') {
    const b = (req.body && typeof req.body === 'object' && Object.keys(req.body).length) ? req.body : await readBody(req);
    moduleCallTool(mod, toolCall[1], b.arguments ?? b)
      .then((r) => send(200, 'application/json', JSON.stringify(r)))
      .catch((e) => send(500, 'application/json', JSON.stringify({ error: e.message })));
    return;
  }
  send(404, 'application/json', JSON.stringify({ error: 'not found' }));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
  });
}

// —— 聚合 MCP 端点（streamable HTTP，暴露给 Codex 对话）——
// 语义照火 firefly：工具名 mcp__<模块id>__<工具名>（超长/非法字符时截断+sha256 后缀），
// description 加 [模块名] 前缀，inputSchema 递归补 type（部分模型 dialect 不接受无 type 的 schema）
function toolAlias(id, name) {
  const full = `mcp__${id}__${name}`;
  if (full.length <= 64 && /^[A-Za-z0-9_-]+$/.test(full)) return full;
  const prefix = full.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 47);
  const hash = crypto.createHash('sha256').update(full).digest('hex').slice(0, 16);
  return `${prefix}_${hash}`;
}
function schemaTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'object') return 'object';
  return 'string';
}
function repairSchema(value, prop) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const r = { ...value };
  delete r.$schema; delete r.title;
  if (r.properties && typeof r.properties === 'object' && !Array.isArray(r.properties)) {
    r.properties = Object.fromEntries(Object.entries(r.properties).map(([k, s]) => [k, repairSchema(s, k)]));
  }
  for (const k of ['items', 'additionalProperties', 'contains']) {
    if (r[k] && typeof r[k] === 'object' && !Array.isArray(r[k])) r[k] = repairSchema(r[k]);
  }
  for (const k of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(r[k])) r[k] = r[k].map((s) => repairSchema(s));
  }
  if (!('type' in r)) {
    if (prop === 'body') r.type = 'object';
    else if (r.properties || r.required || 'additionalProperties' in r) r.type = 'object';
    else if (r.items || r.prefixItems) r.type = 'array';
    else if (Array.isArray(r.enum) && r.enum.length) r.type = schemaTypeOf(r.enum[0]);
    else r.type = 'string';
  }
  return r;
}
async function aggregateModuleTools() {
  const tools = [];
  for (const m of Object.values(registry)) {
    if (!m.enabled || m.transport !== 'stdio') continue; // http 型模块无 MCP 工具（v1）
    let defs;
    try { defs = (await stdioRpc(m, 'tools/list', {}, 8000)).tools || []; } catch { continue; }
    for (const t of defs) {
      tools.push({
        mod: m,
        name: t.name,
        readOnly: t.annotations?.readOnlyHint === true,
        spec: {
          name: toolAlias(m.id, t.name),
          description: `[${m.name}] ${t.description || ''}`.trim(),
          inputSchema: repairSchema(t.inputSchema || { type: 'object' }),
        },
      });
    }
  }
  return tools;
}
export async function mcpEndpoint(req, res) {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const msg = (req.body && typeof req.body === 'object') ? req.body : await readBody(req);
  const { method, params } = msg;
  if (!method) { send(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效请求' } }); return; }
  const notification = msg.id === undefined || msg.id === null;
  const ok = (result) => notification ? res.writeHead(202).end() : send(200, { jsonrpc: '2.0', id: msg.id, result });
  const fail = (message, code = -32000) => notification ? res.writeHead(202).end() : send(200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (method === 'initialize') {
    ok({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'workbench-modules', version: '1.0.0' }, instructions: '工作台启用模块的聚合工具。工具名形如 mcp__模块id__工具名，调用时原样传回即可。' });
    return;
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) { res.writeHead(202).end(); return; }
  if (method === 'ping') { ok({}); return; }
  if (method === 'tools/list') {
    const tools = await aggregateModuleTools();
    ok({ tools: tools.map((t) => t.spec) });
    return;
  }
  if (method === 'tools/call') {
    const tools = await aggregateModuleTools();
    const hit = tools.find((t) => t.spec.name === params?.name);
    if (!hit) { fail(`未知工具: ${params?.name}`, -32602); return; }
    try {
      const r = await stdioCallTool(hit.mod, hit.name, params?.arguments || {});
      ok(r); // 模块级执行错误（isError）原样透传，由模型自行处理
    } catch (e) {
      ok({ isError: true, content: [{ type: 'text', text: String(e.message || e).slice(0, 500) }] });
    }
    return;
  }
  fail(`方法不支持: ${method}`, -32601);
}
function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// —— jobs 调度器 ——
let JOBS_STATE = loadJson(JOBS_FILE, {});
function saveJobsState() { mkdirSync(path.dirname(JOBS_FILE), { recursive: true }); writeFileSync(JOBS_FILE, JSON.stringify(JOBS_STATE, null, 1)); }

function segMatch(part, val) {
  for (const seg of part.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(seg);
    if (!m) continue;
    const [, range, step] = m;
    let lo = 0, hi = 59;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      lo = a; hi = b === undefined ? a : b;
    }
    if (step) { const s = Number(step); if (val >= lo && val <= hi && (val - lo) % s === 0) return true; continue; }
    if (val >= lo && val <= hi) return true;
  }
  return false;
}
function cronMatch(expr, d) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const vals = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  return f.every((part, i) => {
    const v = vals[i];
    if (i === 4) return segMatch(part, v) || (v === 0 && segMatch(part, 7));
    return segMatch(part, v);
  });
}
function latestOccurrence(expr, ref) {
  const d = new Date(ref); d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 7; i++) {
    if (cronMatch(expr, d)) return d.getTime();
    d.setMinutes(d.getMinutes() - 1);
  }
  return 0;
}
export function jobEnabled(id, jobId) {
  const st = JOBS_STATE[`${id}|${jobId}`];
  const manifestJob = registry[id]?.jobs?.find((j) => j.id === jobId);
  return st && st.enabled !== undefined ? !!st.enabled : !!manifestJob?.enabledByDefault;
}
export function setJobEnabled(id, jobId, enabled) {
  const key = `${id}|${jobId}`;
  JOBS_STATE[key] = { ...(JOBS_STATE[key] || {}), enabled };
  saveJobsState();
}
// 宿主退出时杀掉全部 stdio 子进程（官方 SDK 写法的模块不保证 stdin EOF 自退出）
export function killAllStdio() {
  for (const st of Object.values(stdio)) { try { st.proc && st.proc.kill(); } catch {} }
}
export function jobRecords(id) {
  const out = {};
  for (const [key, val] of Object.entries(JOBS_STATE)) {
    if (key.startsWith(id + '|')) out[key.split('|')[1]] = { lastStatus: val.lastStatus, lastOccurrence: val.lastOccurrence, records: (val.records || []).slice(0, 30) };
  }
  return out;
}

let ticking = false;
export async function tickJobs() {
  if (ticking) return; ticking = true;
  try {
    const now = new Date();
    for (const m of Object.values(registry)) {
      if (!m.enabled) continue;
      for (const job of m.jobs || []) {
        if (!job.path && !job.tool) continue;
        if (!jobEnabled(m.id, job.id)) continue;
        const expr = job.cron;
        if (!expr) continue;
        const occ = latestOccurrence(expr, now);
        if (!occ) continue;
        const key = `${m.id}|${job.id}`;
        const st = JOBS_STATE[key] || { lastOccurrence: 0, records: [] };
        if (occ <= (st.lastOccurrence || 0)) continue;
        JOBS_STATE[key] = { ...st, lastOccurrence: occ, lastStatus: 'running' };
        saveJobsState();
        try {
          let ok = true, detail = '';
          if (m.transport === 'http') {
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 60000);
            const r = await fetch(m.baseUrl + job.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: ctl.signal });
            clearTimeout(t);
            const j = await r.json().catch(() => ({}));
            ok = r.ok !== false && !j.error; detail = JSON.stringify(j).slice(0, 200);
          } else {
            const r = await stdioCallTool(m, job.tool, job.arguments || {});
            ok = !r.isError; detail = JSON.stringify(r).slice(0, 200);
          }
          JOBS_STATE[key] = {
            ...JOBS_STATE[key], lastStatus: ok ? 'ok' : 'failed',
            records: [{ ts: Math.floor(Date.now() / 1000), ok, detail }, ...(st.records || [])].slice(0, 100),
          };
          saveJobsState();
        } catch (e) {
          JOBS_STATE[key] = {
            ...JOBS_STATE[key], lastStatus: 'error',
            records: [{ ts: Math.floor(Date.now() / 1000), ok: false, error: String(e.message || e).slice(0, 200) }, ...(st.records || [])].slice(0, 100),
          };
          saveJobsState();
        }
      }
    }
  } finally { ticking = false; }
}

// 进程启动时初始化
if (!existsSync(MODULES_DIR)) mkdirSync(MODULES_DIR, { recursive: true });
scanModules();
