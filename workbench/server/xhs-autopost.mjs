// 每天定时（默认 9:00 / 15:00）按「小红书热门榜第 1 名」自动发一篇，拟人化文案。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestSnapshot, runScan, isScanning } from './xhs-radar.mjs';
import {
  HOTSPOT_CWD, XHS_AUTOPOST, XHS_AUTOPOST_HOURS, XHS_AUTOPOST_METRIC, XHS_AUTOPOST_VISIBILITY,
} from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'xhs-radar');
const STATE_FILE = path.join(DATA_DIR, 'autopost-state.json');

let ticking = false;

const day = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); };

export function topKeyword(snapshot, metric = XHS_AUTOPOST_METRIC) {
  const list = (snapshot?.keywords || []).filter((k) => !k.err && k.n > 0).sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  return list[0] || null;
}

export function buildPostPrompt(k, { visibility = XHS_AUTOPOST_VISIBILITY, slotLabel = '' } = {}) {
  return [
    `【自动发帖任务${slotLabel ? ' · ' + slotLabel : ''}】本次主题品类：${k.kw}`,
    '',
    '背景：这是一个人人都有的普通小红书账号，不是博主号、不是营销号。要写的是一篇**像本人随手记录生活**的图文笔记。',
    '',
    '硬性要求（务必遵守）：',
    '1. 第一人称，像跟朋友随口聊天、讲一件刚发生的小事：要有具体的时间、地点、场景、心情和小细节，别空泛。',
    '2. 用「讲故事」的方式写，不要写成清单体/干货体/教程体；不要小标题、不要大段 emoji、不要「姐妹们/宝子们/家人们」这类博主话术。',
    '3. 不要有引导性、不要营销感：不劝人买东西、不喊「快收藏」「码住」「评论区聊聊」，结尾不要强行升华，自然收住就行（一句小感慨或小玩笑都可以）。',
    '4. 绝对不要有 AI 味：不要「首先/其次/总之/值得一提」，不要工整排比和书面腔；允许口语、短句、语气词，甚至可以有点小啰嗦、小跑题。',
    '5. 标题也要像随手取的（≤20 字），陈述句或生活化感叹即可，不要标题党式悬念。',
    '6. 配图 2~4 张，要「手机随手拍」的质感（用 imagegen 生成时也保持生活化，不要精修大片感、不要明显 AI 感），存到 ~/workProjects/xiaohongshu-mcp/images/，发布时用容器内路径 /app/images/<文件名>。',
    `7. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」。`,
    `8. 可先用 search_feeds 搜「${k.kw}」看几条热帖，只感受语感，严禁照抄。`,
    '',
    '最后把：标题、正文、标签、配图文件名、发布结果 简要回报给我。',
  ].join('\n');
}

async function post({ codex, log, visibility, slotLabel, reason }) {
  let snap = getLatestSnapshot();
  if (!snap || snap.date !== day()) {
    if (isScanning()) return { ok: false, error: '榜单抓取中，稍后重试' };
    log(`[autopost] 今日无榜单，先抓取…（${reason}）`);
    await runScan({ reason: 'autopost' });
    snap = getLatestSnapshot();
    if (!snap || snap.date !== day()) return { ok: false, error: '榜单抓取失败' };
  }
  const top = topKeyword(snap);
  if (!top) return { ok: false, error: '榜单为空' };
  await codex.ensureReady();
  const r = await codex.request('thread/start', { cwd: HOTSPOT_CWD, sandbox: 'danger-full-access', approvalPolicy: 'never' });
  const threadId = r.thread.id;
  const text = buildPostPrompt(top, { visibility, slotLabel });
  await codex.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  log(`[autopost] 已发起：品类=${top.kw}，可见=${visibility}，会话=${threadId}`);
  return { ok: true, threadId, kw: top.kw, visibility };
}

/** 供 /api/xhs-radar/autopost 手动触发（可指定可见范围，默认仅自己可见以便试发） */
export async function postNow({ codex, visibility = '仅自己可见', slotLabel = '手动试发' }) {
  return post({ codex, log: console.log, visibility, slotLabel, reason: 'manual' });
}

async function tick({ codex, log }) {
  if (!XHS_AUTOPOST || ticking) return;
  const h = new Date().getHours();
  const d = day();
  if (!XHS_AUTOPOST_HOURS.includes(h)) return;
  const state = loadState();
  const done = state[d] || [];
  if (done.includes(h)) return;
  ticking = true;
  try {
    const hh = String(h).padStart(2, '0');
    const res = await post({ codex, log, visibility: XHS_AUTOPOST_VISIBILITY, slotLabel: `${hh}:00`, reason: 'schedule' });
    if (res.ok) {
      state[d] = [...done, h];
      state.last = { date: d, hour: h, kw: res.kw, threadId: res.threadId, visibility: res.visibility, at: Date.now() };
      saveState(state);
    }
  } catch (err) {
    log('[autopost] 失败:', err?.message || err);
  } finally { ticking = false; }
}

export function startAutopost({ codex }) {
  if (!XHS_AUTOPOST) { console.log('[autopost] 已关闭'); return; }
  const t = setInterval(() => tick({ codex, log: console.log }), 10 * 60 * 1000);
  t.unref?.();
  tick({ codex, log: console.log });
  console.log(`[autopost] 每天 ${XHS_AUTOPOST_HOURS.map((h) => h + ':00').join(' / ')} 发一篇（榜单第 1 名，${XHS_AUTOPOST_VISIBILITY}）`);
}

export function autopostMeta() {
  const state = loadState();
  return {
    enabled: XHS_AUTOPOST, hours: XHS_AUTOPOST_HOURS, metric: XHS_AUTOPOST_METRIC,
    visibility: XHS_AUTOPOST_VISIBILITY, doneToday: state[day()] || [], last: state.last || null,
  };
}
