// 本地 LLM 清洗代理：app-server → 127.0.0.1:8199 → 公司网关
// 作用：codex 0.164-alpha 发给 /v1/responses 的请求里带公司网关不认识的字段
// （reasoning.summary、client_metadata…，网关 Go 严格解析未知字段直接 400），
// 这里在转发前剥掉；若仍报 unknown field "X"，自动删掉该字段重试（最多 3 次）。
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import dnsPromises from 'node:dns/promises';

const PORT = Number(process.env.LLM_PROXY_PORT || 8199);
const UPSTREAM = (process.env.LLM_UPSTREAM || 'https://aigw-dist03.wondersgroup.com').replace(/\/+$/, '');
const MAX_HEAL_RETRIES = 3;

// 模型名别名改写：旧会话携带的模型名打到新网关会 503（no channel），
// 在转发前改写成新模型。格式 LLM_MODEL_ALIASES="old=new,old2=new2"。
const MODEL_ALIASES = {};
for (const pair of (process.env.LLM_MODEL_ALIASES || '').split(',')) {
  const [from, to] = pair.split('=').map((s) => s && s.trim());
  if (from && to) MODEL_ALIASES[from] = to;
}

// 推理档位别名改写：不同模型支持的 effort 集合不同（如 GLM 只认 low/high/max）。
// 格式 LLM_EFFORT_ALIASES="minimal=low,medium=high"。
const EFFORT_ALIASES = {};
for (const pair of (process.env.LLM_EFFORT_ALIASES || '').split(',')) {
  const [from, to] = pair.split('=').map((s) => s && s.trim());
  if (from && to) EFFORT_ALIASES[from] = to;
}

function rewriteEffort(body) {
  const effort = body?.reasoning?.effort;
  if (typeof effort !== 'string') return;
  const to = EFFORT_ALIASES[effort] || EFFORT_ALIASES[effort.toLowerCase()];
  if (to && to !== effort) {
    console.log(`effort alias: ${effort} -> ${to}`);
    body.reasoning.effort = to;
  }
}

function rewriteModel(body) {
  if (!body || typeof body !== 'object' || !body.model) return;
  const to = MODEL_ALIASES[body.model] || MODEL_ALIASES[String(body.model).toLowerCase()];
  if (to && to !== body.model) {
    console.log(`model alias: ${body.model} -> ${to}`);
    body.model = to;
  }
}

// 默认剥掉的字段：对中转网关无意义且容易踩严格解析
function defaultStrip(body) {
  if (body && typeof body === 'object') {
    if (body.reasoning && typeof body.reasoning === 'object') delete body.reasoning.summary;
    delete body.client_metadata;
  }
}

// 递归删除 JSON 里所有名为 key 的字段（自愈用）
function stripEverywhere(obj, key) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach((v) => stripEverywhere(v, key)); return; }
  delete obj[key];
  for (const v of Object.values(obj)) stripEverywhere(v, key);
}

// ── 上游解析兜底 ─────────────────────────────────────────────
// 公司域名（如 aigw-dist03.wondersgroup.com）是 VPN 内网记录，本机 Tailscale
// MagicDNS(100.100.100.100) 抢了系统解析后查不到 → getaddrinfo ENOTFOUND。
// 这里系统解析失败时自动向公司 DNS 兜底解析（LLM_DNS_SERVERS，逗号分隔），
// 拿到 IP 直连但保留 SNI/Host；结果缓存 DNS_TTL_MS，连接类报错自动清缓存重试。
const UP = new URL(UPSTREAM);
const UP_HOST = UP.hostname;
const UP_TLS = UP.protocol === 'https:';
const UP_PORT = Number(UP.port || (UP_TLS ? 443 : 80));
const UP_MOD = UP_TLS ? https : http;
const DNS_SERVERS = (process.env.LLM_DNS_SERVERS || '10.1.1.10,10.1.1.8')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DNS_TTL_MS = 5 * 60 * 1000;
const SOCKET_RETRY_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EPROTO']);
let upIp = null, upIpAt = 0;

function clearUpIp() { upIp = null; upIpAt = 0; }

async function resolveUpHost() {
  if (upIp && Date.now() - upIpAt < DNS_TTL_MS) return upIp;
  try {
    const { address } = await dnsPromises.lookup(UP_HOST);
    upIp = address; upIpAt = Date.now();
    return address;
  } catch { /* 系统解析失败，走公司 DNS 兜底 */ }
  for (const srv of DNS_SERVERS) {
    try {
      const r = new dnsPromises.Resolver({ timeout: 3000, tries: 1 });
      r.setServers([srv]);
      const addrs = await r.resolve4(UP_HOST);
      if (addrs && addrs[0]) {
        upIp = addrs[0]; upIpAt = Date.now();
        console.log(`upstream resolved: ${UP_HOST} -> ${upIp} via ${srv}`);
        return upIp;
      }
    } catch { /* 试下一个 DNS */ }
  }
  throw new Error(`cannot resolve upstream ${UP_HOST} (system + ${DNS_SERVERS.join('/')})`);
}

async function sendOnce(method, path, headers, bodyBuf) {
  const h = { ...headers };
  delete h.host; delete h['content-length']; delete h.connection; delete h['accept-encoding'];
  if (bodyBuf !== null) h['content-type'] = h['content-type'] || 'application/json';
  h.host = UP_PORT === 80 || UP_PORT === 443 ? UP_HOST : `${UP_HOST}:${UP_PORT}`;
  const ip = await resolveUpHost();
  const payload = bodyBuf === null ? undefined : bodyBuf;
  return await new Promise((resolve, reject) => {
    const ureq = UP_MOD.request({
      host: ip, port: UP_PORT, method, path, headers: h,
      ...(UP_TLS ? { servername: UP_HOST } : {}),
    }, (ures) => {
      const fh = new Headers();
      for (let i = 0; i < ures.rawHeaders.length; i += 2) fh.append(ures.rawHeaders[i], ures.rawHeaders[i + 1]);
      resolve({
        status: ures.statusCode,
        headers: fh,
        body: Readable.toWeb(ures),
        text: () => new Promise((res2, rej2) => {
          const cs = []; ures.on('data', (c) => cs.push(c));
          ures.on('end', () => res2(Buffer.concat(cs).toString('utf8')));
          ures.on('error', rej2);
        }),
      });
    });
    // 连接阶段 15s 超时：IP 过期/网络抖动时快速失败并触发重解析重试
    const connectTimer = setTimeout(() => {
      ureq.destroy(Object.assign(new Error('upstream connect timeout'), { code: 'ETIMEDOUT' }));
    }, 15000);
    ureq.on('socket', (sock) => {
      sock.once(UP_TLS ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    ureq.on('error', (err) => {
      clearTimeout(connectTimer);
      if (SOCKET_RETRY_CODES.has(err.code)) clearUpIp(); // IP 可能过期
      reject(err);
    });
    if (payload === undefined) ureq.end(); else ureq.end(payload);
  });
}

async function forwardOnce(method, path, headers, bodyBuf) {
  try {
    return await sendOnce(method, path, headers, bodyBuf);
  } catch (err) {
    if (SOCKET_RETRY_CODES.has(err.code)) {
      clearUpIp();
      return await sendOnce(method, path, headers, bodyBuf); // 重新解析后再试一次
    }
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);

    let parsed = null;
    const isJson = (req.headers['content-type'] || '').includes('json');
    if (raw.length && isJson) {
      try { parsed = JSON.parse(raw.toString('utf8')); defaultStrip(parsed); rewriteModel(parsed); rewriteEffort(parsed); } catch { parsed = null; }
    }

    let bodyBuf = parsed !== null ? Buffer.from(JSON.stringify(parsed)) : (raw.length ? raw : null);

    let upstream;
    for (let attempt = 0; ; attempt++) {
      upstream = await forwardOnce(req.method, req.url, req.headers, bodyBuf);
      // 只缓冲 4xx（非流式、小包），用于自愈判断；其余直接透传
      if (upstream.status !== 400 || attempt >= MAX_HEAL_RETRIES || parsed === null) break;
      const text = await upstream.text().catch(() => '');
      const m = text && text.match(/unknown field \\?"([\w.]+)\\?"/);
      if (!m) {
        // 不是未知字段问题，原样把 400 回给客户端
        res.writeHead(400, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
        res.end(text); console.log(`${req.method} ${req.url} 400 ${Date.now() - started}ms`);
        return;
      }
      const field = m[1].split('.').pop();
      stripEverywhere(parsed, field);
      console.log(`healed: stripped "${field}" after 400, retry ${attempt + 1}`);
      bodyBuf = Buffer.from(JSON.stringify(parsed));
    }

    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
    console.log(`${req.method} ${req.url} ${upstream.status} ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`${req.method} ${req.url} proxy error:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `llm-proxy: ${err.message}` } }));
    } else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`llm-proxy listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
