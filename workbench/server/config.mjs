import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// 自动发帖任务新建会话的工作目录
export const XHS_WORK_CWD = process.env.XHS_WORK_CWD || process.env.HOTSPOT_CWD || path.join(os.homedir(), 'workProjects', 'xhs-hotspot');

// 「小红书热门雷达」每日扫描的关键词（按「最多点赞」口径统计；可用 XHS_KEYWORDS=a,b,c 覆盖）
export const XHS_KEYWORDS = (process.env.XHS_KEYWORDS
  ? process.env.XHS_KEYWORDS.split(',')
  : ['AI工具', '效率工具', '职场', '打工人', '副业', '搞钱', '情感', '婚姻', '恋爱', '育儿', '带娃',
     '收纳', '清洁技巧', '生活小妙招', '家居', '美食', '护肤', '穿搭', '旅行', '宠物', '减脂', '婆媳']
).map((s) => s.trim()).filter(Boolean);
// 每天几点后自动跑当天的榜（默认 8 点）
export const XHS_RADAR_HOUR = Number(process.env.XHS_RADAR_HOUR || 8);

// 「每天自动发小红书提问帖」：默认开；早/晚两个时间点（整点触发）；主题取榜单第 1 名
export const XHS_AUTOPOST = (process.env.XHS_AUTOPOST || 'on') !== 'off';
// 发帖计划：几点发什么类型。question=提问帖，ai=AI 分享
export const XHS_AUTOPOST_PLAN = (process.env.XHS_AUTOPOST_PLAN || '9=question,15=ai')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [h, t] = s.split('='); return { hour: Number(h), type: (t || 'question').trim() }; })
  .filter((p) => Number.isInteger(p.hour) && p.hour >= 0 && p.hour <= 23);
export const XHS_AUTOPOST_HOURS = XHS_AUTOPOST_PLAN.map((p) => p.hour);
export const XHS_AUTOPOST_METRIC = process.env.XHS_AUTOPOST_METRIC || 'medLikes'; // medLikes | medCol | medSh
export const XHS_AUTOPOST_VISIBILITY = process.env.XHS_AUTOPOST_VISIBILITY || '公开可见'; // 或「仅自己可见」

// 本机已有服务的 1:1 端口代理（外部端口 -> 本机回环服务），保持路径不变，避免破坏绝对路径资源
export const EXTRA_SERVICES = [
  { id: 'db', label: '数据查询', port: Number(process.env.DB_PROXY_PORT || 18777), target: { host: '127.0.0.1', port: Number(process.env.DB_PORT || 8777) }, entry: '/' },
  { id: 'shell', label: '服务器终端', port: Number(process.env.SHELL_PROXY_PORT || 18778), target: { host: '127.0.0.1', port: Number(process.env.SHELL_PORT || 8778) }, entry: '/shell' },
];

// 首页常用会话直达入口（threadId 见 /api/threads）
export const PINNED_SESSIONS = [
  { label: '项目发布', threadId: process.env.PIN_DEPLOY_THREAD || '01a152bf-23d4-7f43-b19d-eed60150bbb6' },
];
