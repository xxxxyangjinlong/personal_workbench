const listeners = new Set();
let es = null;
let currentToken = null;

export function connect(token) {
  if (es && currentToken === token) return;
  disconnect();
  currentToken = token;
  es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  // 每次(重)连上都通知订阅者重新拉取数据：
  // 网关重启会断开 SSE，浏览器自动重连后断线期间的通知补不回来，
  // 这里靠一次“已连接”事件让页面自愈，避免内容停在断线前的旧状态。
  es.addEventListener('open', () => {
    for (const l of listeners) l({ method: '__connected', params: {} });
  });
  es.addEventListener('notification', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    for (const l of listeners) l(msg);
  });
  es.addEventListener('serverRequest', (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    for (const l of listeners) l({ ...msg, __serverRequest: true });
  });
}
export function disconnect() { if (es) { es.close(); es = null; } currentToken = null; }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
