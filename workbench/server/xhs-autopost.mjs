// 定时自动发（周历模式：周一/三/五 10:00 提问帖 · 周二/四 19:30 热点解读 · 周日 19:30 汇总帖 · 周六留给人工干货）；类型：question / hot / figure / weekly / devlog
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestSnapshot, runScan, isScanning } from './xhs-radar.mjs';
import {
  XHS_WORK_CWD, XHS_AUTOPOST, XHS_AUTOPOST_SLOTS, XHS_AUTOPOST_ROTATION, XHS_AUTOPOST_PLAN,
  XHS_AUTOPOST_METRIC, XHS_AUTOPOST_VISIBILITY, XHS_FIGURE_TOPICS_FILE, XHS_ROTATE_DAYS, DEVLOG_LOOKBACK_DAYS,
  XHS_QUESTIONS_FILE, XHS_PIN_COMMENT,
} from './config.mjs';
import { collectCommits, anonymize } from './devlog.mjs';

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

const GROWTH = [
  '【涨粉规则 · 重点】这个号现在粉丝很少，发帖不是为了显摆干货，而是让人愿意点进来、愿意回一句、顺手关注你。',
  '· 标题要具体、有画面：带场景/地点/数字/时间，像「早上十点的徐浦大桥」这种，别用「关于XX的一些想法」这种空标题，也别夸大标题党。',
  '· 第一句就直接进场景，别铺垫背景：开口就是「今天在……」「刚遇到一件事」，不要「众所周知 / 随着…的发展」这种开头。',
  '· 正文里留一个「人人有话说」的点：一个问题、一个二选一、或一个大家都有过的经历，让人看完想回一句。',
  '· 让人记住你是个真实的人（一个爱记录生活的程序员，常在上海，能自然带上本地细节就带），但别自吹、别立「大神」人设。',
  '· 话题标签 3~6 个：1 个大众标签（如 打工人 / 程序员 / 上海）+ 2~3 个跟正文具体内容贴合的标签；别堆一堆不相干的热门标签。',
  '· 封面决定点击率：文字卡上放最短最抓人的那一句，字要大、好读，别把长句子塞上去。',
  '· 绝不引导：不放链接、不留联系方式、不喊「关注我 / 收藏 / 码住 / 评论区告诉我」，平台和读者都反感，反而限流。',
].join('\n');

const TEXTCARD = '~/workProjects/personal-workbench/workbench/tools/textcard.mjs';
const IMG_DIR = '~/workProjects/xiaohongshu-mcp/images';
const AI_TOPICS_FILE = path.join(XHS_WORK_CWD, 'ai-topics.txt');
const FIGURE_USED_FILE = path.join(XHS_WORK_CWD, 'figure-used.txt');
const QUESTIONS_FILE = XHS_QUESTIONS_FILE;
const QUESTIONS_USED_FILE = path.join(XHS_WORK_CWD, 'questions-used.txt');

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

// —— 提问帖问题池：每行「问题 :: 一句小字(可空)」，已发的记入 questions-used.txt，用完从头循环 ——
function parseQuestions() {
  return readLines(QUESTIONS_FILE)
    .filter((l) => !l.startsWith('#'))
    .map((l) => { const [q, sub] = l.split('::').map((s) => (s || '').trim()); return { q, sub: sub || '' }; })
    .filter((x) => x.q);
}
function pickQuestion() {
  const used = new Set(readLines(QUESTIONS_USED_FILE));
  const all = parseQuestions();
  return all.find((x) => !used.has(x.q)) || all[0] || null;
}

// —— 周报上下文：本周提问帖 + 期数 + 下周问题预告（定时与手动补发共用） ——
function weeklyCtx(state) {
  const hist = state?.history || [];
  const weekQs = hist
    .filter((h) => h.type === 'question' && h.date >= dayBefore(6) && h.date <= day())
    .map((h) => h.kw).slice(-6);
  const seq = hist.filter((h) => h.type === 'weekly').length + 1;
  const nq = pickQuestion();
  return { questions: weekQs, seq, nextQuestion: nq ? nq.q : '（问题池待补充，见 questions.txt）' };
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

function buildQuestionPrompt(qItem, { visibility, slotLabel }) {
  const tr = timeRule(slotLabel);
  return [
    `【自动发帖任务 · 提问帖${slotLabel ? ' · ' + slotLabel : ''}】`,
    '',
    '这是一个普通人的小红书账号（爱折腾 AI 和自动化、正在搭自己的「第二大脑」）。今天发一条「提问帖」：抛出一个大家愿意搭话的问题，靠评论互动。',
    ...(tr ? ['', tr] : []),
    '',
    `本期问题（来自选题池，核心意思不能变，措辞可以改得更口语）：${qItem.q}`,
    ...(qItem.sub ? [`可用的小字/补充：${qItem.sub}`] : []),
    '',
    '要求：',
    '1. 围绕上面的问题写，第一人称，像自己真的在纠结/好奇，可以带一句自己的情况做铺垫；不要宏大、不要说教、不要引战，且必须与发布时间相符。',
    '2. 只用口语，不要博主腔（不要「姐妹们/宝子们/家人们」），不要 AI 腔（不要「首先/其次/总之」、不要工整排比）。',
    '3. 正文 2~4 句：铺垫 + 问题。',
    '4. 【例外条款】正文结尾必须原样带上这一句固定的话：「每周日我把大家的回答整理成一篇盘点，想被翻牌的先关注～」——这是本账号唯一允许的引导话术，其余引导（评论区告诉我/码住/收藏/留联系方式）仍然一律禁止。',
    '5. 标题 ≤20 字，就是问题本身或它的精简版（固定那句翻牌话术不放标题里）。',
    '6. 配图用**纯文字卡片**（严禁 AI 生图、严禁照片），用本地脚本生成：',
    `   node ${TEXTCARD} --text "<问题>" [--sub "<一句小字>"] --out ${IMG_DIR}/ask-<短标识>.png`,
    '   生成 1~2 张（例如一张主问题、一张补充），确认图片生成成功（脚本会在 stdout 打印路径）。',
    `7. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    `8. 发布成功后，立刻用 xiaohongshu-mcp 的 post_comment_to_feed 在这条笔记下发第一条评论，内容原样用：「${XHS_PIN_COMMENT}」`,
    '9. 可先用 search_feeds 搜相关关键词感受一下语感，严禁照抄。',
    '',
    GROWTH,
    '',
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、发布结果。',
  ].join('\n');
}

function buildHotPrompt(k, { visibility, slotLabel }) {
  const tr = timeRule(slotLabel);
  return [
    `【自动发帖任务 · 热点解读${slotLabel ? ' · ' + slotLabel : ''}】本周小红书上「${k.kw}」相关内容热度最高。`,
    '',
    '这是一个程序员的小红书账号：主人正在自建一套「AI 第二大脑」（本地知识库 + 自动化工作流）。今天发一条「AI 人物 / 大技术 · 自建派解读」——不做新闻转述，用自己正在做的事去接住这个热点。',
    ...(tr ? ['', tr] : []),
    '',
    '要求：',
    `1. 围绕「${k.kw}」，先用 search_feeds 搜一下这个词，找出最近最火的一个具体大事件 / 大技术 / 人物动作（选一条最有料的，并在回报里注明你选了什么）。`,
    '2. 角度必须是「自建派」：这事对我自己搭的 AI 工作流 / 对想搭个人知识库的普通人，意味着什么。给出 2~3 条具体影响或可抄的做法。',
    '3. 【诚实底线】没实测过的结论一律写成「我的判断 / 我的预期」，严禁编造实测数据、跑分、对比结果；可以写账号主人系统里真实存在的做法（自建知识库、本地部署、自动化发帖等），但不要透露敏感细节。',
    '4. 第一人称口语，不捧不踩、不引战、不碰敏感话题；不要博主腔、不要 AI 腔。',
    '5. 结尾必须落回自己的赛道一句话（例如「这事我会先在自己知识库的 XX 环节试，下周汇报」）。',
    '6. 正文 4~7 句（200 字内），标题 ≤20 字。',
    '7. 配图用**纯文字卡片**（严禁 AI 生图、严禁照片）：',
    `   node ${TEXTCARD} --text "<一句话观点>" --points "<要点1|要点2|要点3>" [--sub "<一句小字>"] --out ${IMG_DIR}/hot-<短标识>.png`,
    `8. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    '',
    GROWTH,
    '',
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、本次选的热点、发布结果。',
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
    '2. 观点必须带「自建派」视角：他说的 / 做的，对我自己搭的 AI 工作流、对想搭个人知识库的普通人意味着什么；像跟朋友随口聊，不捧不踩。',
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
    GROWTH,
    '',
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、人物、发布结果。',
  );
  return lines.join('\n');
}

function buildWeeklyPrompt(ctx, { visibility, slotLabel }) {
  const tr = timeRule(slotLabel);
  const lines = [
    `【自动发帖任务 · 周日汇总帖${slotLabel ? ' · ' + slotLabel : ''}】第 ${ctx.seq} 期`,
    '',
    '这是一个程序员的小红书账号，固定栏目「第二大脑周报」：把本周提问帖评论区的好回答整理成一篇盘点，兑现「想被翻牌的先关注」的承诺。',
    `本周发过的提问帖（标题列表，共 ${ctx.questions.length} 条）：`,
    ...ctx.questions.map((q) => `- ${q}`),
  ];
  if (tr) lines.push('', tr);
  lines.push(
    '',
    '做法（严格按步骤）：',
    '1. 用 xiaohongshu-mcp 的 get_my_profile（tab=note）拿到最近笔记列表，找到上面这些提问帖，记下 id 和 xsecToken。',
    '2. 逐篇用 get_feed_detail（feed_id + xsec_token）读取评论，但**只读够用的量**：loadAllComments 设为 false，只取前 20 条，别点「更多回复」、别滚动加载全部；单篇 60 秒没返回就直接跳过，不要反复重试，继续下一篇。',
    '2.1 【降级】如果评论确实拉不到（超时/为空），就不要硬凑：改为「本周提问回顾 + 每条问题的一个通用观察 + 下周预告」的轻量版，明确只写你自己看到的、不编造任何网友回答或昵称。',
    '3. 挑出 3~5 条最有信息量 / 最真实 / 最有共鸣的回答（标准：具体、有细节、不灟水）。',
    '4. 每条按「引用原回答（可用昵称）→ 你的一两句专业点评（这是干货本体，说明它好在哪、补充什么做法）」来写。',
    '5. 【诚实底线】如果某篇评论很少或整体不足 3 条好的，就做「单条深挖」版（只选 1 条，写透），或者把本周热点解读的精华并进来；**严禁编造或改写评论原意**。',
    '6. 结构固定：开头钩子（回顾本周问题+数据，如收到多少条回答）→ 精选回答逐条 → 「下周问题预告」→ 结尾原样带上：「每周日我把大家的回答整理成一篇盘点，想被翻牌的先关注～」',
    `7. 下周问题预告用这一条：「${ctx.nextQuestion}」`,
    '8. 正文 150~250 字，标题 ≤20 字（例：「本周最扎心的 5 条回答｜第二大脑周报 #'+ctx.seq+'」，数字按实际）。',
    '9. 配图用**纯文字卡片**（严禁 AI 生图、严禁照片）：',
    `   node ${TEXTCARD} --text "第二大脑周报 #${ctx.seq}" --points "<精选回答者昵称1|精选2|精选3>" [--sub "<一句话钩子>"] --out ${IMG_DIR}/weekly-<短标识>.png`,
    `10. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    '',
    GROWTH,
    '',
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、入选回答数量、发布结果。',
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
    GROWTH,
    '',
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、发布结果。',
  );
  return lines.join('\n');
}

function collectDevlog() {
  const today = collectCommits({ since: 'midnight' });
  const base = today.commits.length ? { commits: today.commits, scope: '今天提交的' } : { commits: collectCommits({ since: `${DEVLOG_LOOKBACK_DAYS} days ago` }).commits, scope: `最近 ${DEVLOG_LOOKBACK_DAYS} 天提交的` };
  const names = [...new Set(base.commits.map((c) => c.repo))];
  base.commits = base.commits.map((c) => ({ ...c, subject: anonymize(c.subject, names) }));
  return base;
}

function buildDevlogPrompt(info, { visibility, slotLabel }) {
  const tr = timeRule(slotLabel);
  const lines = [
    `【自动发帖任务 · 代码日常${slotLabel ? ' · ' + slotLabel : ''}】`,
    '',
    '这是一个程序员的小红书账号。今天发一条「我最近写了点啥」的日常，像跟朋友随口唠唠手头的活，顺便和大家聊聊。',
    '',
    `素材（本人最近的代码提交，共 ${info.commits.length} 条，${info.scope}）：`,
    ...info.commits.map((c) => `- ${c.subject}`),
  ];
  if (tr) lines.push('', tr);
  lines.push(
    '',
    '要求：',
    '1. 从素材里挑 **1~2 件**最有意思 / 最有共情的，用第一人称讲：在做什么、卡在哪、怎么绕过去的。别罗列所有提交。只挑**偏技术性**的（方案、踩坑、思路、工具用法）；涉及具体业务 / 客户 / 数据的，直接不要选。',
    '2. 用大白话，像跟同事唠嗑；不要博主腔、专家腔、AI 腔；不要「首先 / 其次 / 总之」。',
    '3. 【隐私·最高优先级】整条帖子**只谈技术，不谈业务**。**绝对不要**出现：公司名、项目名 / 产品名、内部系统名、客户或同事姓名、接口 / 域名 / URL / IP、代码片段、工单号、分支名、具体业务数据。一律抽象成「一个后台服务」「一个内部工具」「一个页面」这类通用说法。宁可写得笼统，也绝不能露任何可识别的人或组织的信息。不确定能不能说的，就别说。',
    '4. 结尾真诚抛一个小问题，邀请大家聊聊（比如「你们平时遇到这种会怎么弄」），但不要「评论区告诉我 / 收藏 / 码住」这类硬引导。',
    '5. 正文 4~7 句，标题 ≤20 字，可以带点自嘲或烟火气。',
    '6. 配图用**纯文字卡片**（严禁 AI 生图、严禁照片），用本地脚本生成：',
    `   node ${TEXTCARD} --text "<一句话主题>" --points "<要点1|要点2|要点3>" [--sub "<一句小字>"] --out ${IMG_DIR}/dev-<短标识>.png`,
    `7. 用 xiaohongshu-mcp 的 publish_content 发布，visibility 设为「${visibility}」；图片路径用容器内路径 /app/images/<文件名>。`,
    '',
    GROWTH,
    '',
    ANTI_AI,
    '',
    '最后回报：标题、正文、标签、图片文件名、发布结果。',
  );
  return lines.join('\n');
}

export function buildPostPrompt(ctx, { visibility = XHS_AUTOPOST_VISIBILITY, slotLabel = '', type = 'question' } = {}) {
  if (type === 'hot') return buildHotPrompt(ctx, { visibility, slotLabel });
  if (type === 'figure') return buildFigurePrompt(ctx, { visibility, slotLabel });
  if (type === 'devlog') return buildDevlogPrompt(ctx, { visibility, slotLabel });
  if (type === 'weekly') return buildWeeklyPrompt(ctx, { visibility, slotLabel });
  return buildQuestionPrompt(ctx, { visibility, slotLabel });
}

async function post({ codex, log, visibility, slotLabel, reason, type = 'question', ctx = null }) {
  const state = loadState();
  let k = { kw: 'AI' };
  if (type === 'devlog') {
    const info = collectDevlog();
    if (!info.commits.length) return { ok: true, skipped: true, kw: '(无提交)', type, visibility };
    k = { kw: '代码日常', devlog: info };
  } else if (type === 'figure') {
    const fig = pickFigure();
    if (!fig) return { ok: false, error: `未配置热点人物，请在 ${XHS_FIGURE_TOPICS_FILE} 添加（每行：名字 :: 观点 :: 图片URL）` };
    k = { kw: fig.name, figure: fig };
  } else if (type === 'hot') {
    let snap = getLatestSnapshot();
    if (!snap || snap.date !== day()) {
      if (isScanning()) return { ok: false, error: '榜单抓取中，稍后重试' };
      log(`[autopost] 今日无榜单，先抓取…（${reason}）`);
      await runScan({ reason: 'autopost' });
      snap = getLatestSnapshot();
      if (!snap || snap.date !== day()) return { ok: false, error: '榜单抓取失败' };
    }
    const top = topKeyword(snap, XHS_AUTOPOST_METRIC);
    if (!top) return { ok: false, error: '榜单为空' };
    k = top;
  } else if (type === 'weekly') {
    k = { kw: `周报#${ctx?.seq ?? '?'}`, weekly: ctx || { questions: [], seq: 1, nextQuestion: '' } };
  } else {
    const qItem = pickQuestion();
    if (!qItem) return { ok: false, error: `问题池为空，请在 ${QUESTIONS_FILE} 添加（每行一个问题）` };
    k = { kw: qItem.q, question: qItem };
  }
  await codex.ensureReady();
  const r = await codex.request('thread/start', { cwd: XHS_WORK_CWD, sandbox: 'danger-full-access', approvalPolicy: 'never' });
  const threadId = r.thread.id;
  const pctx = type === 'devlog' ? k.devlog : type === 'figure' ? k.figure : type === 'weekly' ? k.weekly : type === 'question' ? k.question : k;
  const text = buildPostPrompt(pctx, { visibility, slotLabel, type });
  await codex.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  log(`[autopost] 已发起：类型=${type}，主题=${k.kw}，可见=${visibility}，会话=${threadId}`);
  return { ok: true, threadId, kw: k.kw, type, visibility, question: k.question?.q || '' };
}

/** 供 /api/xhs-radar/autopost 手动触发（默认仅自己可见以便试发） */
export async function postNow({ codex, visibility = '仅自己可见', slotLabel = '手动试发', type = 'question' }) {
  const ctx = type === 'weekly' ? weeklyCtx(loadState()) : null;
  return post({ codex, log: console.log, visibility, slotLabel, reason: 'manual', type, ctx });
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
  const dow = ((now.getDay() + 6) % 7) + 1; // 1=周一 … 7=周日
  const state = loadState();
  const done = state[d] || [];
  const weekMode = XHS_AUTOPOST_PLAN.some((p) => p.weekday);
  let slots; let types;
  if (weekMode) {
    // 周历模式：只按 PLAN 里排到今天的条目发，没排到的时段留给人工干货帖
    slots = XHS_AUTOPOST_PLAN.filter((p) => p.weekday === dow);
    types = slots.map((p) => p.type);
  } else {
    slots = XHS_AUTOPOST_SLOTS;
    const dayTypes = typesForDay(d, slots.length);
    types = slots.map((p, i) => planTypeFor(p) || dayTypes[i] || 'question');
  }
  const idx = slots.findIndex((p) => !done.includes(slotKey(p)) && p.hour === h && m >= (p.minute || 0));
  if (idx < 0) return;
  const slot = slots[idx];
  const key = slotKey(slot);
  const type = types[idx];
  ticking = true;
  try {
    let extraCtx = null;
    if (type === 'weekly') {
      const hist = state.history || [];
      const weekQs = hist.filter((hh) => hh.type === 'question' && hh.date >= dayBefore(6) && hh.date <= d).map((hh) => hh.kw).slice(-6);
      const seq = hist.filter((hh) => hh.type === 'weekly').length + 1;
      const nq = pickQuestion();
      extraCtx = { questions: weekQs, seq, nextQuestion: nq ? nq.q : '（问题池待补充，见 questions.txt）' };
    }
    const res = await post({ codex, log, visibility: XHS_AUTOPOST_VISIBILITY, slotLabel: key, reason: 'schedule', type, ctx: extraCtx });
    if (res.ok) {
      state[d] = [...done, key];
      state.history = [...(state.history || []).slice(-200), { date: d, hour: slot.hour, minute: slot.minute, kw: res.kw, type: res.type }];
      state.last = { date: d, slot: key, kw: res.kw, type: res.type, threadId: res.threadId, visibility: res.visibility, at: Date.now() };
      if (res.type === 'figure') {
        try { writeFileSync(FIGURE_USED_FILE, [...readLines(FIGURE_USED_FILE), res.kw].join('\n') + '\n'); } catch {}
      }
      if (res.type === 'question' && res.question) {
        try { writeFileSync(QUESTIONS_USED_FILE, [...readLines(QUESTIONS_USED_FILE), res.question].join('\n') + '\n'); } catch {}
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
  const label = (x) => (x === 'hot' ? '热点解读' : x === 'figure' ? '人物观点' : x === 'devlog' ? '代码日常' : x === 'weekly' ? '汇总帖' : '提问帖');
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
