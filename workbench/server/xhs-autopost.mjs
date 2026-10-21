// 定时自动发（默认计划 10:00 提问帖 / 19:30 AI 分享）；类型：question / ai / figure。
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestSnapshot, runScan, isScanning } from './xhs-radar.mjs';
import {
  XHS_WORK_CWD, XHS_AUTOPOST, XHS_AUTOPOST_SLOTS, XHS_AUTOPOST_ROTATION, XHS_AUTOPOST_PLAN,
  XHS_AUTOPOST_METRIC, XHS_AUTOPOST_VISIBILITY, XHS_FIGURE_TOPICS_FILE, XHS_ROTATE_DAYS,
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
const slotKey = (p) => `${String(p.hour).padStart(2, '0')}:${String(p.minute || 0).padStart(2, '0')}`;

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

/** 按发布时段给出「内容要和时间点相符」的规则 */
function timeRule(slotLabel) {
  const h = Number(String(slotLabel || '').split(':')[0]);
  if (!Number.isInteger(h)) return '';
  const label = h >= 5 && h < 11 ? '上午上班时段'
    : h >= 11 && h < 14 ? '中午午休时段'
      : h >= 14 && h < 18 ? '下午上班时段'
        : h >= 18 && h < 23 ? '晚上下班后' : '深夜';
  return `【时间】本次在「${label}」（${slotLabel}）发布。内容必须和时间点相符：上午别发「下班了干嘛 / 熬夜 / 睡前」这类晚上的内容，晚上别发「刚上班 / 上午开会」这类上午的内容；问题也要是那个时段的人真会聊的。`;
}

// 统一的「反 AI 味」硬规则，三种帖子都要遵守
const ANTI_AI = '【反 AI 味 · 必须遵守】写完自己读一遍，别让人一眼看出是 AI 写的：不要「首先 / 其次 / 最后 / 总之 / 值得注意的是 / 希望对你有帮助」这类套话；不要排比、对仗、句句工整；不要滥用 emoji、波浪号、感叹号；不要「让我们一起 / 宝子们 / 家人们」这种口号腔。用词口语化，允许一点口头禅和轻微的不完美，就像在微信里跟朋友随手打的一段话。';

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

// —— 每天把轮换池里的类型「按天平移」分配到各时段：保证每个时段都会轮到不同类型 ——
const dayIndex = (dateStr) => { const [y, mo, da] = dateStr.split('-').map(Number); return Math.floor(Date.UTC(y, mo - 1, da) / 86400000); };
export function typesForDay(dateStr, n) {
  let rot = [...new Set((XHS_AUTOPOST_ROTATION && XHS_AUTOPOST_ROTATION.length) ? XHS_AUTOPOST_ROTATION : ['question', 'ai'])];
  rot = rot.filter((t) => t !== 'figure' || pickFigure());
  if (!rot.length) rot = ['question'];
  const off = ((dayIndex(dateStr) % rot.length) + rot.length) % rot.length;
  return Array.from({ length: n }, (_, i) => rot[(off + i) % rot.length]);
}
function planTypeFor(slot) {
  const hit = (XHS_AUTOPOST_PLAN || []).find((p) => p.hour === slot.hour && p.minute === (slot.minute || 0));
  return hit ? hit.type : null;
}

function buildQuestionPrompt(k, { visibility, slotLabel }) {
  const tr = timeRule(slotLabel);
  return [
    `【自动发帖任务 · 提问帖${slotLabel ? ' · ' + slotLabel : ''}】本次主题品类：${k.kw}`,
    '',
    '这是一个普通人的小红书账号。今天发一条「提问帖」：抛出一个大家愿意搭话的问题，靠评论互动。',
    ...(tr ? ['', tr] : []),
    '',
    '要求：',
    `1. 结合品类「${k.kw}」，想一个具体、生活化、门槛低的问题——看到就想说一句的那种；不要宏大、不要说教、不要引战；且必须与上面的发布时间相符。`,
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
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、发布结果。',
  ].join('\n');
}

function buildAiSharePrompt({ visibility, slotLabel }) {
  const recent = recentAiTopics();
  const tr = timeRule(slotLabel);
  return [
    `【自动发帖任务 · AI分享${slotLabel ? ' · ' + slotLabel : ''}】`,
    '',
    '这是一个普通人的小红书账号。账号主人是程序员，日常在用各种 AI 工具，自己也搭了些自动化的小东西。',
    '今天发一条「AI 使用分享」，目标：让人觉得"这人是真的在用，这个我马上能试"。',
    ...(tr ? ['', tr] : []),
    '',
    '要求：',
    '1. 只讲**一个很具体的小点**：某个 AI 工具的用法 / 一个踩过的坑 / 一个前后对比 / 自己搭的小东西。不要泛泛谈"AI 改变了生活"。',
    '2. 第一人称口语，像随口跟同事说一句「我最近发现…」；不要博主腔（不要「姐妹们/宝子们」）、不要专家腔、不要 AI 腔（不要「首先/其次/总之」、不要工整排比）。',
    '3. 不要引导性：不放链接、不喊「关注我/评论区/码住/收藏」、不推销任何产品或课程。',
    '4. 正文 4~7 句，比提问帖多说一点、把这件事讲透，但别啰嗦（正文控制在 200 字以内）；标题 ≤20 字。',
    '5. 用大家都能听懂的大白话：别堆专业术语；万一非提某个词（比如 agent、上下文、token），就在后面用一句人话解释，或者干脆换个通俗说法。宁可多写一句解释，也别让人看不懂。',
    '6. 配图用**纯文字卡片**（严禁 AI 生图、严禁照片），用本地脚本生成：',
    `   node ${TEXTCARD} --text "<一句话主题或结论>" --points "<要点1|要点2|要点3>" [--sub "<一句小字>"] --out ${IMG_DIR}/ai-<短标识>.png`,
    '   生成 1~2 张（例如一张主题+要点的卡片，必要时再来一张）。',
    `7. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    recent.length ? `8. 避免和最近发过的重复（最近发过：${recent.join('、')}），换一个角度。` : '8. 尽量选一个小而具体的角度。',
    `9. 发布成功后，把本次选题的一个短关键词（2~6 字）作为一行，追加写入 ${AI_TOPICS_FILE}（文件不存在就创建）。`,
    '',
    ANTI_AI,
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
  const tr = timeRule(slotLabel);
  if (tr) lines.push('', tr);
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
      `   • 用公开渠道的真实照片：先把 ${figure.photo} 下载到 ${IMG_DIR}/（例如 curl -L -o ${IMG_DIR}/fig-<短标识>.jpg "<URL>"），发布时用容器内路径 /app/images/<文件名>；可再配一张文字卡。`,
      '     下载后确认文件是有效图片（file 命令 / 大小 >10KB），否则改用文字卡。',
    );
  } else {
    lines.push(`   • 没有真实照片，就用本地文字卡：node ${TEXTCARD} --text "<人物名或他的观点>" --sub "<一句小字>" --out ${IMG_DIR}/fig-<短标识>.png`);
  }
  lines.push(
    `7. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    '8. 可先用 search_feeds 搜这个人名，感受下大家怎么聊的，严禁照抄。',
    '',
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、人物、发布结果。',
  );
  return lines.join('\n');
}

function buildCustomPrompt({ topic, images = [] }, { visibility, timeLabel }) {
  const tr = timeRule(timeLabel);
  const lines = [
    '【自动发帖任务 · 自定义】',
    '',
    '这是一个程序员 / 普通人的小红书账号。用户自己给了想发的主题或想法，请把它写成一条自然的小红书帖子。',
    '',
    `用户想发的内容：${topic || '（见用户上传的图片）'}`,
  ];
  if (tr) lines.push('', tr);
  if (images.length) {
    lines.push('', `用户上传了 ${images.length} 张真实图片（已经在图片目录里）：${images.join('、')}。配图直接用这些图片，路径用容器内路径 /app/images/<文件名>；**不要**用 AI 生图、也不要另外造图。标题需要的话可再补一张文字卡。`);
  } else {
    lines.push('', '用户没有上传图片。配图用本地文字卡（严禁 AI 生图、严禁照片）：');
    lines.push(`   node ${TEXTCARD} --text "<一句话主题>" [--sub "<一句小字>"] --out ${IMG_DIR}/custom-<短标识>.png`);
  }
  lines.push(
    '',
    '要求：',
    '1. 以用户给的原意为准，不要改变意思；但要把话改得更口语、更像真人随手发的，不要写成营销文案。',
    '2. 第一人称、口语；不要博主腔、专家腔、AI 腔。',
    '3. 不要引导性：不放链接、不喊「关注我 / 评论区 / 码住 / 收藏」、不推销任何产品或课程。',
    '4. 正文 3~7 句，别太长；标题 ≤20 字。',
    '5. 用大家都能听懂的大白话：别堆专业术语；万一非提某个词，就顺带用一句人话解释。',
    `6. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    '',
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、发布结果。',
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

/** 自定义主题发帖（用户手填内容 + 可选上传图片） */
export async function postCustom({ codex, visibility = '公开可见', topic = '', images = [] }) {
  const t = String(topic || '').trim();
  if (!t && !images.length) return { ok: false, error: '请填写内容或上传图片' };
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const timeLabel = `${p(now.getHours())}:${p(now.getMinutes())}`;
  await codex.ensureReady();
  const r = await codex.request('thread/start', { cwd: XHS_WORK_CWD, sandbox: 'danger-full-access', approvalPolicy: 'never' });
  const threadId = r.thread.id;
  const text = buildCustomPrompt({ topic: t, images }, { visibility, timeLabel });
  await codex.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  console.log(`[autopost] 已发起：类型=custom，可见=${visibility}，图片=${images.length}，会话=${threadId}`);
  return { ok: true, threadId, type: 'custom', visibility };
}

async function tick({ codex, log }) {
  if (!XHS_AUTOPOST || ticking) return;
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const d = day();
  const slots = XHS_AUTOPOST_SLOTS;
  const dayTypes = typesForDay(d, slots.length);
  const state = loadState();
  const done = state[d] || [];
  const idx = slots.findIndex((p) => !done.includes(slotKey(p)) && p.hour === h && m >= (p.minute || 0));
  if (idx < 0) return;
  const slot = slots[idx];
  const key = slotKey(slot);
  const type = planTypeFor(slot) || dayTypes[idx] || 'question';
  ticking = true;
  try {
    const res = await post({ codex, log, visibility: XHS_AUTOPOST_VISIBILITY, slotLabel: key, reason: 'schedule', type });
    if (res.ok) {
      state[d] = [...done, key];
      state.history = [...(state.history || []).slice(-200), { date: d, hour: slot.hour, minute: slot.minute, kw: res.kw, type: res.type }];
      state.last = { date: d, slot: key, kw: res.kw, type: res.type, threadId: res.threadId, visibility: res.visibility, at: Date.now() };
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
  console.log(`[autopost] 时段：${XHS_AUTOPOST_SLOTS.map(slotKey).join(' / ')} · 类型轮换：${(XHS_AUTOPOST_ROTATION || []).map(label).join(' / ')}（${XHS_AUTOPOST_VISIBILITY}）· 提问帖避让最近 ${XHS_ROTATE_DAYS} 天同品类`);
}

export function autopostMeta() {
  const state = loadState();
  return {
    enabled: XHS_AUTOPOST, metric: XHS_AUTOPOST_METRIC,
    slots: XHS_AUTOPOST_SLOTS, rotation: XHS_AUTOPOST_ROTATION, plan: XHS_AUTOPOST_PLAN,
    visibility: XHS_AUTOPOST_VISIBILITY, rotateDays: XHS_ROTATE_DAYS,
    figureTopicsFile: XHS_FIGURE_TOPICS_FILE,
    doneToday: state[day()] || [], last: state.last || null,
  };
}
