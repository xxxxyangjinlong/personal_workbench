// 热点雷达：聚合微博/百度/知乎/头条/抖音热搜（公开只读接口）
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function getJSON(url, timeout = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: new URL(url).origin + '/', Accept: 'application/json, text/plain, */*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

const num = (v) => (v === 0 || v ? String(v) : '');

async function weibo() {
  const j = await getJSON('https://weibo.com/ajax/side/hotSearch');
  const list = j?.data?.realtime || [];
  return list.filter((x) => x && x.word && !x.is_ad)
    .map((x) => ({ title: x.word, hot: num(x.raw_hot || x.num), label: x.label_name || '', url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + x.word + '#')}` }));
}

async function baidu() {
  const j = await getJSON('https://top.baidu.com/api/board?platform=wise&tab=realtime');
  const list = j?.data?.cards?.[0]?.content?.[0]?.content || [];
  return list.filter((x) => x && (x.word || x.query))
    .map((x) => ({ title: x.word || x.query, hot: num(x.hotScore), label: x.hotTag && x.hotTag !== '0' ? '热' : '', url: x.url || `https://www.baidu.com/s?wd=${encodeURIComponent(x.word || x.query)}` }));
}

async function zhihu() {
  const j = await getJSON('https://api.zhihu.com/topstory/hot-lists/total?limit=50&reverse_order=0');
  const list = j?.data || [];
  return list.filter((x) => x?.target?.title).map((x) => {
    const m = /questions\/(\d+)/.exec(x.target.url || '');
    const url = `https://www.zhihu.com/question/${m ? m[1] : x.target.id}`;
    return { title: x.target.title, hot: String(x.detail_text || '').replace(/热度$/, '').trim(), label: '', url };
  });
}

async function toutiao() {
  const j = await getJSON('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc');
  const list = j?.data || [];
  return list.filter((x) => x && x.Title).map((x) => ({ title: x.Title, hot: num(x.HotValue), label: x.Label || '', url: x.Url }));
}

async function douyin() {
  const j = await getJSON('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/');
  const list = j?.word_list || [];
  return list.filter((x) => x && x.word).map((x) => ({ title: x.word, hot: num(x.hot_value), label: '', url: `https://www.douyin.com/search/${encodeURIComponent(x.word)}` }));
}

const SOURCES = [
  { id: 'weibo', label: '微博', icon: '🟥', fn: weibo },
  { id: 'baidu', label: '百度', icon: '🔵', fn: baidu },
  { id: 'zhihu', label: '知乎', icon: '🔷', fn: zhihu },
  { id: 'toutiao', label: '头条', icon: '🟧', fn: toutiao },
  { id: 'douyin', label: '抖音', icon: '⬛', fn: douyin },
];

let cache = { at: 0, data: null };
const TTL = 5 * 60 * 1000;

export async function getHotspots({ refresh = false } = {}) {
  if (!refresh && cache.data && Date.now() - cache.at < TTL) return cache.data;
  const sources = await Promise.all(SOURCES.map(async (s) => {
    try {
      const items = (await s.fn()).slice(0, 50).map((it, i) => ({ rank: i + 1, ...it }));
      return { id: s.id, label: s.label, icon: s.icon, ok: items.length > 0, items };
    } catch (err) {
      return { id: s.id, label: s.label, icon: s.icon, ok: false, error: String(err?.message || err), items: [] };
    }
  }));
  const data = { updatedAt: Date.now(), sources };
  cache = { at: Date.now(), data };
  return data;
}
