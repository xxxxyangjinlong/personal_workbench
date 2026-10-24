// 本地 LLM 清洗代理：app-server → 127.0.0.1:8199 → 公司网关
// 作用：codex 0.164-alpha 发给 /v1/responses 的请求里带公司网关不认识的字段
// （reasoning.summary、client_metadata…，网关 Go 严格解析未知字段直接 400），
// 这里在转发前剥掉；若仍报 unknown field "X"，自动删掉该字段重试（最多 3 次）。
import http from 'node:http';
import { Readable } from 'node:stream';

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

async function forwardOnce(method, path, headers, bodyBuf) {
  const h = { ...headers };
  delete h.host; delete h['content-length']; delete h.connection; delete h['accept-encoding'];
  if (bodyBuf !== null) h['content-type'] = h['content-type'] || 'application/json';
  const res = await fetch(UPSTREAM + path, {
    method, headers: h,
    body: bodyBuf === null ? undefined : bodyBuf,
    duplex: bodyBuf === null ? undefined : 'half',
  });
  return res;
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
      try { parsed = JSON.parse(raw.toString('utf8')); defaultStrip(parsed); rewriteModel(parsed); } catch { parsed = null; }
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
