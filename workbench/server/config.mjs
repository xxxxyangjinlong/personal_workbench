import { existsSync } from 'node:fs';
import os from 'node:os';

const CANDIDATE_BINS = [
  process.env.CODEX_BIN,
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  `${os.homedir()}/.codex/bin/codex`,
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
];

export const CODEX_BIN = CANDIDATE_BINS.find((p) => p && existsSync(p)) || 'codex';
export const PORT = Number(process.env.PORT || 8080);
export const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'codex-mobile';
export const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();
export const DEFAULT_SANDBOX = process.env.DEFAULT_SANDBOX || 'workspace-write';
export const DEFAULT_APPROVAL = process.env.DEFAULT_APPROVAL || 'never';
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || null;

export const TERMINAL_ENABLED = (process.env.TERMINAL || 'on') !== 'off';
export const TTYD_PORT = Number(process.env.TTYD_PORT || 7681);
export const TTYD_BASE = process.env.TTYD_BASE || '/term';
export const TMUX_SESSION = process.env.TMUX_SESSION || 'main';

// 本机已有服务的 1:1 端口代理（外部端口 -> 本机回环服务），保持路径不变，避免破坏绝对路径资源
export const EXTRA_SERVICES = [
  { id: 'db', label: '数据查询', port: Number(process.env.DB_PROXY_PORT || 18777), target: { host: '127.0.0.1', port: Number(process.env.DB_PORT || 8777) }, entry: '/' },
  { id: 'shell', label: '服务器终端', port: Number(process.env.SHELL_PROXY_PORT || 18778), target: { host: '127.0.0.1', port: Number(process.env.SHELL_PORT || 8778) }, entry: '/shell' },
];

// 首页常用会话直达入口（threadId 见 /api/threads）
export const PINNED_SESSIONS = [
  { label: '项目发布', threadId: process.env.PIN_DEPLOY_THREAD || '01a152bf-23d4-7f43-b19d-eed60150bbb6' },
];
