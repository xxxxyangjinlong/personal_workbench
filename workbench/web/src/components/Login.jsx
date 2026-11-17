import React, { useState } from 'react';
import { api, setToken } from '../api';

export default function Login({ onLogin }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await api.login(value.trim());
      if (!res.ok) throw new Error('令牌不正确');
      setToken(value.trim());
      onLogin(value.trim());
    } catch (err) {
      setError(err.message || '登录失败');
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-mark">W</div>
        <div className="login-kicker">Personal Workbench</div>
        <h1>欢迎回来</h1>
        <p className="muted">输入访问令牌，连接本机 Codex</p>
        <form onSubmit={submit}>
          <input
            type="password"
            placeholder="访问令牌"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <button disabled={busy || !value}>{busy ? '登录中…' : '进入工作台'}</button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
