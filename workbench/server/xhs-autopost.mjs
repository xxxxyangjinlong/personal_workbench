// 定时自动发（默认计划 9:00 提问帖 / 15:00 AI 分享）；类型：question / ai / figure。
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestSnapshot, runScan, isScanning } from './xhs-radar.mjs';
import {
  XHS_WORK_CWD, XHS_AUTOPOST, XHS_AUTOPOST_PLAN, XHS_AUTOPOST_HOURS, XHS_AUTOPOST_METRIC, XHS_AUTOPOST_VISIBILITY,
  XHS_FIGURE_TOPICS_FILE, XHS_ROTATE_DAYS,
} from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'xhs-radar');
const STATE_FILE = path.join(DATA_DIR, 'autopost-state.json');

let ticking = false;

const day = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const dayBefore = (n) => { const d = new Date(); d.setDate(d.getDate() - n); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 1)); };
const readLines = (f) => { try { return readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean); } catch { return []; } };

/** 取榜单第 1 名；exclude 内的品类会被跳过（用于同品类隔天不重复） */
export function topKeyword(snapshot, metric = XHS_AUTOPOST_METRIC, exclude = []) {
  const ex = new Set(exclude.map((s) => String(s).trim()).filter(Boolean));
  const list = (snapshot?.keywords || []).filter((k) => !k.err && k.n > 0).sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  return list.find((k) => !ex.has(k.kw)) || list[0] || null;
}

/** 最近 N 天（不含今天）已发过的提问帖品类 */
function recentUsedKeywords(state, days = XHS_ROTATE_DAYS) {
  const exDates = new Set(Array.from({ length: days }, (_, i) => dayBefore(i + 1)));
  return (state.history || []).filter((h) => h.type === 'question' && exDates.has(h.date)).map((h) => h.kw);
}

const TEXTCARD = '~/workProjects/personal-workbench/workbench/tools/textcard.mjs';
const IMG_DIR = '~/workProjects/xiaohongshu-mcp/images';
const AI_TOPICS_FILE = path.join(XHS_WORK_CWD, 'ai-topics.txt');
const FIGURE_USED_FILE = path.join(XHS_WORK_CWD, 'figure-used.txt');

function recentAiTopics(n = 6) { return readLines(AI_TOPICS_FILE).slice(-n); }

// —— 热点人物清单：每行「名字 :: 观点/线索 :: 图片URL或本地路径(可空)」 ——
function parseFigures() {
  return readLines(XHS_FIGURE_TOPICS_FILE)
    .filter((l) => !l.startsWith('#'))
    .map((l) => { const [name, note, photo] = l.split('::').map((s) => (s || '').trim()); return { name, note: note || '', photo: photo || '' }; })
    .filter((f) => f.name);
}
function pickFigure() {
  const used = new Set(readLines(FIGURE_USED_FILE));
  const all = parseFigures();
  return all.find((f) => !used.has(f.name)) || all[0] || null;
}

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

function buildAiSharePrompt({ visibility, slotLabel }) {
  const recent = recentAiTopics();
  return [
    `【自动发帖任务 · AI分享${slotLabel ? ' · ' + slotLabel : ''}】`,
    '',
    '这是一个普通人的小红书账号。账号主人是程序员，日常在用各种 AI 工具，自己也搭了些自动化的小东西。',
    '今天发一条「AI 使用分享」，目标：让人觉得"这人是真的在用，这个我马上能试"。',
    '',
    '要求：',
    '1. 只讲**一个很具体的小点**：某个 AI 工具的用法 / 一个踩过的坑 / 一个前后对比 / 自己搭的小东西。不要泛泛谈"AI 改变了生活"。',
    '2. 第一人称口语，像随口跟同事说一句「我最近发现…」；不要博主腔（不要「姐妹们/宝子们」）、不要专家腔、不要 AI 腔（不要「首先/其次/总之」、不要工整排比）。',
    '3. 不要引导性：不放链接、不喊「关注我/评论区/码住/收藏」、不推销任何产品或课程。',
    '4. 正文 3~6 句，标题 ≤20 字，朴实一点。',
    '5. 配图用**纯文字卡片**（严禁 AI 生图、严禁照片），用本地脚本生成：',
    `   node ${TEXTCARD} --text "<一句话主题或结论>" --points "<要点1|要点2|要点3>" [--sub "<一句小字>"] --out ${IMG_DIR}/ai-<短标识>.png`,
    '   生成 1~2 张（例如一张主题+要点的卡片，必要时再来一张）。',
    `6. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    recent.length ? `7. 避免和最近发过的重复（最近发过：${recent.join('、')}），换一个角度。` : '7. 尽量选一个小而具体的角度。',
    `8. 发布成功后，把本次选题的一个短关键词（2~6 字）作为一行，追加写入 ${AI_TOPICS_FILE}（文件不存在就创建）。`,
    '',
    '最后回报：标题、正文、标签、图片文件名、本次选题关键词、发布结果。',
  ].join('\n');
}

function buildFigurePrompt(figure, { visibility, slotLabel }) {
  const lines = [
    `【自动发帖任务 · 热点人物观点${slotLabel ? ' · ' + slotLabel : ''}】人物：${figure.name}`,
    '',
    '这是一个程序员的小红书账号。今天聊一个最近很火的 AI / 科技人物，分享他一个观点或做法，再加一句自己的真实感受。',
  ];
  if (figure.note) lines.push(`人物线索（供参考，别照抄）：${figure.note}`);
  lines.push(
    '',
    '要求：',
    '1. 用大白话讲清这人是谁、他说的/做的那个点是什么；头衔最多一句带过，别堆名头。',
    '2. 加一句自己的真实看法或感受，像跟朋友随口聊，不捧不踩。',
    '3. 第一人称、口语；不要博主腔（不要「姐妹们/宝子们」）、不要 AI 腔（不要「首先/其次/总之」、不要工整排比）。',
    '4. 不引战、不蹭政治、不碰中美对立等敏感话题，不做价值评判，只聊技术 / 方法 / 经历。',
    '5. 正文 3~6 句，标题 ≤20 字。',
    '6. 配图（严禁 AI 生图、严禁伪造或合成他人照片）：',
  );
  if (figure.photo) {
    lines.push(
      `   • 用真实照片：先把 ${figure.photo} 下载到 ${IMG_DIR}/（例如 curl -L -o ${IMG_DIR}/fig-<短标识>.jpg "<URL>"），发布时用容器内路径 /app/images/<文件名>；可再配一张文字卡。`,
      `     下载后确认文件是有效图片（file 命令 / 大小 >10KB），否则改用文字卡。`,
    );
  } else {
    lines.push(`   • 没有真实照片，就用本地文字卡：node ${TEXTCARD} --text "<人物名或他的观点>" --sub "<一句小字>" --out ${IMG_DIR}/fig-<短标识>.png`);
  }
  lines.push(
    `7. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    '8. 可先用 search_feeds 搜这个人名，感受下大家怎么聊的，严禁照抄。',
    '',
    '最后回报：标题、正文、标签、图片文件名、人物、发布结果。',
  );
  return lines.join('\n');
}

export function buildPostPrompt(ctx, { visibility = XHS_AUTOPOST_VISIBILITY, slotLabel = '', type = 'question' } = {}) {
  if (type === 'ai') return buildAiSharePrompt({ visibility, slotLabel });
  if (type === 'figure') return buildFigurePrompt(ctx, { visibility, slotLabel });
  return buildQuestionPrompt(ctx, { visibility, slotLabel });
}

async function post({ codex, log, visibility, slotLabel, reason, type = 'question' }) {
  const state = loadState();
  let k = { kw: 'AI' };
  if (type === 'figure') {
    const fig = pickFigure();
    if (!fig) return { ok: false, error: `未配置热点人物，请在 ${XHS_FIGURE_TOPICS_FILE} 添加（每行：名字 :: 观点 :: 图片URL）` };
    k = { kw: fig.name, figure: fig };
  } else if (type !== 'ai') {
    let snap = getLatestSnapshot();
    if (!snap || snap.date !== day()) {
      if (isScanning()) return { ok: false, error: '榜单抓取中，稍后重试' };
      log(`[autopost] 今日无榜单，先抓取…（${reason}）`);
      await runScan({ reason: 'autopost' });
      snap = getLatestSnapshot();
      if (!snap || snap.date !== day()) return { ok: false, error: '榜单抓取失败' };
    }
    const top = topKeyword(snap, XHS_AUTOPOST_METRIC, recentUsedKeywords(state));
    if (!top) return { ok: false, error: '榜单为空' };
    k = top;
  }
  await codex.ensureReady();
  const r = await codex.request('thread/start', { cwd: XHS_WORK_CWD, sandbox: 'danger-full-access', approvalPolicy: 'never' });
  const threadId = r.thread.id;
  const ctx = type === 'figure' ? k.figure : k;
  const text = buildPostPrompt(ctx, { visibility, slotLabel, type });
  await codex.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  log(`[autopost] 已发起：类型=${type}，主题=${k.kw}，可见=${visibility}，会话=${threadId}`);
  return { ok: true, threadId, kw: k.kw, type, visibility };
}

/** 供 /api/xhs-radar/autopost 手动触发（默认仅自己可见以便试发） */
export async function postNow({ codex, visibility = '仅自己可见', slotLabel = '手动试发', type = 'question' }) {
  return post({ codex, log: console.log, visibility, slotLabel, reason: 'manual', type });
}

async function tick({ codex, log }) {
  if (!XHS_AUTOPOST || ticking) return;
  const h = new Date().getHours();
  const d = day();
  const slot = XHS_AUTOPOST_PLAN.find((p) => p.hour === h);
  if (!slot) return;
  const state = loadState();
  const done = state[d] || [];
  if (done.includes(h)) return;
  ticking = true;
  try {
    const hh = String(h).padStart(2, '0');
    const res = await post({ codex, log, visibility: XHS_AUTOPOST_VISIBILITY, slotLabel: `${hh}:00`, reason: 'schedule', type: slot.type });
    if (res.ok) {
      state[d] = [...done, h];
      state.history = [...(state.history || []).slice(-200), { date: d, hour: h, kw: res.kw, type: res.type }];
      state.last = { date: d, hour: h, kw: res.kw, type: res.type, threadId: res.threadId, visibility: res.visibility, at: Date.now() };
      if (res.type === 'figure') {
        try { writeFileSync(FIGURE_USED_FILE, [...readLines(FIGURE_USED_FILE), res.kw].join('\n') + '\n'); } catch {}
      }
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
  const label = (x) => (x === 'ai' ? 'AI分享' : x === 'figure' ? '人物观点' : '提问帖');
  console.log(`[autopost] 计划：${XHS_AUTOPOST_PLAN.map((p) => `${p.hour}:00 ${label(p.type)}`).join(' / ')}（${XHS_AUTOPOST_VISIBILITY}）· 提问帖避让最近 ${XHS_ROTATE_DAYS} 天同品类`);
}

export function autopostMeta() {
  const state = loadState();
  return {
    enabled: XHS_AUTOPOST, hours: XHS_AUTOPOST_HOURS, metric: XHS_AUTOPOST_METRIC,
    plan: XHS_AUTOPOST_PLAN, visibility: XHS_AUTOPOST_VISIBILITY, rotateDays: XHS_ROTATE_DAYS,
    figureTopicsFile: XHS_FIGURE_TOPICS_FILE,
    doneToday: state[day()] || [], last: state.last || null,
  };
}
