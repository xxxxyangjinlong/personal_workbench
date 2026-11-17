// 小红书模块自有配置（自 workbench/server/config.mjs 的 XHS/DEVLOG 部分独立而来，改这里不影响网关）
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

// 自动发帖任务新建会话的工作目录
export const XHS_WORK_CWD = process.env.XHS_WORK_CWD || process.env.HOTSPOT_CWD || path.join(HOME, 'workProjects', 'xhs-hotspot');

// 「小红书热门雷达」每日扫描的关键词（按「最多点赞」口径统计；可用 XHS_KEYWORDS=a,b,c 覆盖）
export const XHS_KEYWORDS = (process.env.XHS_KEYWORDS
  ? process.env.XHS_KEYWORDS.split(',')
  : ['AI工具', '效率工具', '职场', '打工人', '副业', '搞钱', '情感', '婚姻', '恋爱', '育儿', '带娃',
     '收纳', '清洁技巧', '生活小妙招', '家居', '美食', '护肤', '穿搭', '旅行', '宠物', '减脂', '婆媳']
).map((s) => s.trim()).filter(Boolean);
// 每天几点后自动跑当天的榜（默认 8 点）——模块内自调度已停用，此值仅用于展示
export const XHS_RADAR_HOUR = Number(process.env.XHS_RADAR_HOUR || 8);

// 「每天自动发小红书帖」：默认开
export const XHS_AUTOPOST = (process.env.XHS_AUTOPOST || 'on') !== 'off';
// 发布时段（周历模式由 PLAN 定义；SLOTS 为展示与兜底）
export const XHS_AUTOPOST_SLOTS = (process.env.XHS_AUTOPOST_SLOTS || '10:00,19:30')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [h, m] = s.split(':'); return { hour: Number(h), minute: Number(m || 0) }; })
  .filter((p) => Number.isInteger(p.hour) && p.hour >= 0 && p.hour <= 23 && Number.isInteger(p.minute) && p.minute >= 0 && p.minute <= 59);
export const XHS_AUTOPOST_HOURS = XHS_AUTOPOST_SLOTS.map((p) => p.hour);
// 内容类型轮换池
export const XHS_AUTOPOST_ROTATION = (process.env.XHS_AUTOPOST_ROTATION || 'question,figure')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((t) => (['question', 'hot', 'figure', 'devlog'].includes(t) ? t : 'question'));
// 周历排期（默认 v3：周一三五 10:00 提问帖 / 周二四 19:30 热点解读 / 周日 19:30 汇总帖）
export const XHS_AUTOPOST_PLAN = (process.env.XHS_AUTOPOST_PLAN
  || '1-10:00=question,2-19:30=hot,3-10:00=question,4-19:30=hot,5-10:00=question,7-19:30=weekly')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [t, ty] = s.split('='); let wd = null; let tt = t || '';
    const wm = tt.match(/^([1-7])-/); if (wm) { wd = Number(wm[1]); tt = tt.slice(2); }
    const [h, m] = tt.split(':'); return { weekday: wd, hour: Number(h), minute: Number(m || 0), type: (ty || 'question').trim() }; })
  .filter((p) => Number.isInteger(p.hour) && ['question', 'hot', 'figure', 'weekly', 'devlog'].includes(p.type));
export const XHS_AUTOPOST_METRIC = process.env.XHS_AUTOPOST_METRIC || 'medLikes';
export const XHS_AUTOPOST_VISIBILITY = process.env.XHS_AUTOPOST_VISIBILITY || '公开可见';

// 「热点人物观点」帖的人物清单
export const XHS_FIGURE_TOPICS_FILE = process.env.XHS_FIGURE_TOPICS_FILE || path.join(XHS_WORK_CWD, 'figure-topics.txt');
// 提问帖「同品类隔天不重复」
export const XHS_ROTATE_DAYS = Number(process.env.XHS_ROTATE_DAYS || 2);
// 提问帖问题池
export const XHS_QUESTIONS_FILE = process.env.XHS_QUESTIONS_FILE || path.join(XHS_WORK_CWD, 'questions.txt');
// 提问帖发布后的固定首评话术
export const XHS_PIN_COMMENT = process.env.XHS_PIN_COMMENT || '每周日我把大家的回答整理成一篇盘点，想被翻牌的先关注～';

// 小红书 MCP 的图片目录（宿主机）——对应容器内 /app/images
export const XHS_IMG_DIR = process.env.XHS_IMG_DIR || path.join(HOME, 'workProjects', 'xiaohongshu-mcp', 'images');

// 「代码日常」帖取材的 git 仓库根目录
export const DEVLOG_ROOTS = (process.env.DEVLOG_ROOTS
  ? process.env.DEVLOG_ROOTS.split(':').filter(Boolean)
  : ['workProjects', 'IdeaProjects', 'PycharmProjects', 'CodeBuddy', 'rustProjects', 'minprogram', 'PyCharmMiscProject']
    .map((d) => path.join(HOME, d)));
export const DEVLOG_LOOKBACK_DAYS = Number(process.env.DEVLOG_LOOKBACK_DAYS || 3);

// 小红书 MCP 服务地址
export const XHS_MCP_URL = process.env.XHS_MCP_URL || 'http://127.0.0.1:18060/mcp';
