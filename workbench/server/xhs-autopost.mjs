// 每天定时（默认 9:00 / 15:00）按「小红书热门榜第 1 名」自动发一篇，拟人化文案。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestSnapshot, runScan, isScanning } from './xhs-radar.mjs';
import {
  XHS_WORK_CWD, XHS_AUTOPOST, XHS_AUTOPOST_HOURS, XHS_AUTOPOST_METRIC, XHS_AUTOPOST_VISIBILITY,
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

const TEXTCARD = '~/workProjects/personal-workbench/workbench/tools/textcard.mjs';
const IMG_DIR = '~/workProjects/xiaohongshu-mcp/images';

function buildQuestionPrompt(k, { visibility, slotLabel }) {
  return [
    `【自动发帖任务 · 提问帖${slotLabel ? ' · ' + slotLabel : ''}】本次主题品类：${k.kw}`,
    '',
    '这是一个普通人的小红书账号。今天发一条「提问帖」：抛出一个大家愿意搭话的问题，靠评论互动。',
    '',
    '要求：',
    `1. 结合品类「${k.kw}」，想一个具体、生活化、门槛低的问题——看到就想说一句的那种；不要宏大、不要说教、不要引战。`,
    '2. 第一人称，像自己真的在纠结/好奇/想吐槽某件事，可以带一句自己的情况做铺垫。',
    '3. 只用口语，不要博主腔（不要「姐妹们/宝子们/家人们」），不要 AI 腔（不要「首先/其次/总之」、不要工整排比）。',
    '4. 正文 2~4 句：铺垫 + 问题。结尾可以轻轻问一句「你们呢」，但不要「评论区告诉我/快收藏/码住」这类硬引导。',
    '5. 标题 ≤20 字，就是问题本身或它的精简版。',
    '6. 配图用**纯文字卡片**（严禁 AI 生图、严禁照片），用本地脚本生成：',
    `   node ${TEXTCARD} --text "<问题>" [--sub "<一句小字>"] --out ${IMG_DIR}/ask-<短标识>.png`,
    '   生成 1~2 张（例如一张主问题、一张补充），确认图片生成成功（脚本会在 stdout 打印路径）。',
    `7. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    `8. 可先用 search_feeds 搜「${k.kw}」感受一下语感，严禁照抄。`,
    '',
    '最后回报：标题、正文、标签、图片文件名、发布结果。',
  ].join('\n');
}

export function buildPostPrompt(k, { visibility = XHS_AUTOPOST_VISIBILITY, slotLabel = '' } = {}) {
  return buildQuestionPrompt(k, { visibility, slotLabel });
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
  const r = await codex.request('thread/start', { cwd: XHS_WORK_CWD, sandbox: 'danger-full-access', approvalPolicy: 'never' });
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
