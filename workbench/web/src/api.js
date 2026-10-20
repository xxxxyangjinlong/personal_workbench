let token = localStorage.getItem('cm_token') || '';
// 支持通过 ?token=xxx 直接登录（方便快速进入/调试）
try {
  const u = new URL(location.href);
  const qt = u.searchParams.get('token');
  if (qt) { token = qt; localStorage.setItem('cm_token', qt); u.searchParams.delete('token'); history.replaceState(null, '', u.pathname + (u.search || '') + u.hash); }
} catch {}
export const getToken = () => token;
export const setToken = (t) => { token = t; localStorage.setItem('cm_token', t); };
export const clearToken = () => { token = ''; localStorage.removeItem('cm_token'); };

async function req(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) { const e = new Error('unauthorized'); e.code = 401; e.status = 401; throw e; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || data.error || res.statusText);
    e.status = res.status; e.code = data.error;
    throw e;
  }
  return data;
}

export const api = {
  login: (t) => fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) }),
  health: () => req('/api/health'),
  models: () => req('/api/models'),
  threads: (q = '') => req('/api/threads' + q),
  projects: () => req('/api/projects'),
  services: () => req('/api/services'),
  running: () => req('/api/running'),
  createThread: (body = {}) => req('/api/threads', { method: 'POST', body: JSON.stringify(body) }),
  thread: (id) => req(`/api/threads/${id}`),
  turns: (id, q = '') => req(`/api/threads/${id}/turns${q}`),
  sendTurn: (id, body) => req(`/api/threads/${id}/turns`, { method: 'POST', body: JSON.stringify(body) }),
  interrupt: (id) => req(`/api/threads/${id}/interrupt`, { method: 'POST', body: '{}' }),
  forkThread: (id) => req(`/api/threads/${id}/fork`, { method: 'POST', body: '{}' }),
  deleteThread: (id) => req(`/api/threads/${id}`, { method: 'DELETE' }),
  archiveThread: (id) => req(`/api/threads/${id}/archive`, { method: 'POST', body: '{}' }),
  respond: (body) => req('/api/respond', { method: 'POST', body: JSON.stringify(body) }),
};
