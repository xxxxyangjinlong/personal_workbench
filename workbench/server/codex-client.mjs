import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * Thin JSON-RPC client for `codex app-server` over stdio.
 * Methods are the app-server protocol strings, e.g. "thread/list", "turn/start".
 */
export class CodexClient extends EventEmitter {
  constructor({ codexBin, cwd, requestTimeoutMs = 120_000, wsUrl } = {}) {
    super();
    this.codexBin = codexBin || 'codex';
    // 若提供 wsUrl（或环境变量 APP_SERVER_WS），则连接「长活 app-server」而非自起 stdio 子进程
    this.wsUrl = wsUrl || process.env.APP_SERVER_WS || '';
    this.cwd = cwd || process.cwd();
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.ws = null;
    this._reconnectTimer = null;
    this._stopped = false;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this._starting = null;
    this.lastStderr = '';
  }

  start() {
    if (this._starting) return this._starting;
    this._starting = this.wsUrl ? this._startWs() : this._startStdio();
    return this._starting;
  }

  // 通过 WebSocket 连接长活 app-server（`codex app-server --listen ws://…`）。
  // 它的进程独立于本网关：网关重启 / 热重载不会杀掉它，正在执行的回合得以继续。
  _startWs() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.wsUrl); }
      catch (err) { this._starting = null; reject(err); return; }
      this.ws = ws;
      ws.on('open', () => {
        this._request('initialize', {
          clientInfo: { name: 'codex-mobile', title: '随身办公', version: '0.1.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        })
          .then((res) => { this.ready = true; this._starting = null; this.emit('status', { state: 'ready', info: res }); resolve(res); })
          .catch((err) => { this.ready = false; this._starting = null; reject(err); });
      });
      ws.on('message', (data) => this._onLine(data.toString()));
      ws.on('error', (err) => {
        this.ready = false;
        this.emit('status', { state: 'error', error: String(err) });
        if (this._starting) { this._starting = null; reject(err); }
      });
      ws.on('close', (code) => {
        this.ready = false;
        this._starting = null;
        this.ws = null;
        for (const p of this.pending.values()) p.reject(new Error('app-server connection closed'));
        this.pending.clear();
        this.emit('status', { state: 'exited', code, signal: null });
        if (!this._stopped) this._scheduleReconnect();
      });
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._stopped) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.start().catch(() => {});
    }, 2000);
    this._reconnectTimer.unref?.();
  }

  _startStdio() {
    return new Promise((resolve, reject) => {
      // thread_unload_delay_secs：会话空闲 N 秒后自动从 app-server 卸载，
      // 释放它对客户端的独占写锁（~/.codex/thread-writer-locks/*.lock）；
      // 否则网关会一直占着会话写锁，导致电脑端读不到最新/写不进去（不同步）。
      const idleSecs = Number(process.env.THREAD_UNLOAD_DELAY_SECS ?? 30);
      const args = ['app-server'];
      if (Number.isFinite(idleSecs) && idleSecs > 0) args.push('-c', `thread_unload_delay_secs=${Math.floor(idleSecs)}`);
      const child = spawn(this.codexBin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.child = child;

      child.on('error', (err) => {
        this.ready = false;
        this._starting = null;
        this.emit('status', { state: 'error', error: String(err) });
        reject(err);
      });
      child.on('exit', (code, signal) => {
        this.ready = false;
        this._starting = null;
        this.emit('status', { state: 'exited', code, signal });
        for (const p of this.pending.values()) p.reject(new Error('app-server exited'));
        this.pending.clear();
      });

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => this._onLine(line));
      child.stderr.on('data', (d) => {
        this.lastStderr = (this.lastStderr + d.toString()).slice(-4000);
      });

      this._request('initialize', {
        clientInfo: { name: 'codex-mobile', title: '随身办公', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
        .then((res) => {
          this.ready = true;
          this.emit('status', { state: 'ready', info: res });
          resolve(res);
        })
        .catch((err) => {
          this.ready = false;
          this._starting = null;
          reject(err);
        });
    });
  }

  async ensureReady() {
    if (this.wsUrl) {
      if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    } else if (this.ready && this.child && !this.child.killed) return;
    await this.start();
  }

  request(method, params) {
    return this._request(method, params);
  }

  respond(id, result) {
    this._write({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message) {
    this._write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  _write(obj) {
    if (this.wsUrl) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('app-server not running');
      this.ws.send(JSON.stringify(obj));
      return;
    }
    if (!this.child || !this.child.stdin.writable) throw new Error('app-server not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this._write({ jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout after ${this.requestTimeoutMs}ms: ${method}`));
        }
      }, this.requestTimeoutMs);
    });
  }

  _onLine(line) {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { this.emit('raw', line); return; }

    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && msg.method) { this.emit('serverRequest', msg); return; }
    if (hasId) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) this.emit('notification', msg);
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.ready = false;
    this._starting = null;
  }
}
