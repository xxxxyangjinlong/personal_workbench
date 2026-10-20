import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

/**
 * Thin JSON-RPC client for `codex app-server` over stdio.
 * Methods are the app-server protocol strings, e.g. "thread/list", "turn/start".
 */
export class CodexClient extends EventEmitter {
  constructor({ codexBin, cwd, requestTimeoutMs = 120_000 } = {}) {
    super();
    this.codexBin = codexBin || 'codex';
    this.cwd = cwd || process.cwd();
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this._starting = null;
    this.lastStderr = '';
  }

  start() {
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
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
    return this._starting;
  }

  async ensureReady() {
    if (this.ready && this.child && !this.child.killed) return;
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
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.ready = false;
    this._starting = null;
  }
}
