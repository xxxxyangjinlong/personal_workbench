#!/usr/bin/env node
// 生成「纯文字卡片」封面图（中文字体本地渲染，不会有 AI 生成的乱码字）。
// 用法：
//   node textcard.mjs --text "你们公司团建要自费吗？" [--sub "说说你的经历"] [--out /path/a.png]
//                    [--theme light|dark] [--size 1080x1440] [--points "要点1|要点2|要点3"]
import { writeFileSync, mkdtempSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const text = arg('text');
if (!text) { console.error('缺少 --text'); process.exit(2); }
const sub = arg('sub', '');
const points = arg('points', '').split('|').map((s) => s.trim()).filter(Boolean).slice(0, 6);
const theme = arg('theme', 'light');
const [W, H] = (arg('size', '1080x1440')).split('x').map(Number);
const out = path.resolve(arg('out', path.join(tmpdir(), `textcard-${Date.now()}.png`)));

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PADX = 96;
const CONTENT_W = W - PADX * 2;
const MAX_SIZE = 140;
const hasPts = points.length > 0;

// —— 智能断行：中文按宽度、ASCII 词（AI / bug / 8777）不拆、标点不落行首、优先在标点后断 ——
const PUNCT = '，。！？；：、,.!?;:';
const LEAD_PUNCT = /^[，。！？；：、,.!?;:)\]】」』%…~-]/;
const widthOf = (s) => { let w = 0; for (const ch of s) w += ch.charCodeAt(0) < 256 ? 0.55 : 1; return w; };
function tokenize(t) {
  const toks = []; let buf = '';
  for (const ch of t) {
    if (/[0-9A-Za-z]/.test(ch)) { buf += ch; continue; }
    if (buf) { toks.push(buf); buf = ''; }
    toks.push(ch);
  }
  if (buf) toks.push(buf);
  return toks;
}
function splitByWidth(t, budget) {
  const toks = tokenize(t); const out = []; let cur = ''; let curW = 0;
  for (const tk of toks) {
    const w = widthOf(tk);
    if (cur && curW + w > budget && !LEAD_PUNCT.test(tk)) { out.push(cur); cur = ''; curW = 0; }
    cur += tk; curW += w;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function splitLines(t, maxLines) {
  const totalW = widthOf(t);
  const n = Math.max(1, Math.min(maxLines, totalW <= 5 ? 1 : totalW <= 15 ? 2 : 3));
  const budget = totalW / n;
  const toks = tokenize(t); const segs = []; let s = '';
  for (const tk of toks) { s += tk; if (tk.length === 1 && PUNCT.includes(tk)) { segs.push(s); s = ''; } }
  if (s) segs.push(s);
  const flat = [];
  for (const seg of segs) {
    if (widthOf(seg) > budget * 1.35) flat.push(...splitByWidth(seg, budget));
    else flat.push(seg);
  }
  const lines = []; let cur = ''; let curW = 0;
  for (const seg of flat) {
    const w = widthOf(seg);
    if (cur && lines.length < n - 1 && curW + w > budget * 1.2) { lines.push(cur); cur = ''; curW = 0; }
    cur += seg; curW += w;
  }
  if (cur) lines.push(cur);
  return lines.map((s) => s.trim()).filter(Boolean);
}
const titleLines = splitLines(text, 3);
const maxLen = Math.max(...titleLines.map((l) => l.length), 1);
const fitted = Math.floor(CONTENT_W / (maxLen * 1.06));
const size = Math.max(40, Math.min(MAX_SIZE, fitted)) * (hasPts ? 0.82 : 1);
const titleHtml = titleLines.map((l) => esc(l)).join('<br>');
const dark = theme === 'dark';
const bg = dark ? '#101014' : '#ffffff';
const fg = dark ? '#f5f5f7' : '#141418';
const subFg = dark ? 'rgba(245,245,247,.55)' : 'rgba(20,20,24,.45)';
const accent = dark ? 'rgba(245,245,247,.14)' : 'rgba(20,20,24,.10)';

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:${bg};}
  .wrap{width:${W}px;height:${H}px;display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:120px 96px;box-sizing:border-box;
        font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Heiti SC","Microsoft YaHei",sans-serif;}
  .rule{width:72px;height:6px;border-radius:3px;background:${accent};margin-bottom:56px;}
  .t{font-size:${size}px;line-height:1.5;font-weight:600;color:${fg};text-align:center;letter-spacing:1px;word-break:keep-all;}
  .s{margin-top:48px;font-size:${Math.round(size * 0.42)}px;line-height:1.5;color:${subFg};text-align:center;letter-spacing:1px;}
  .pts{margin:56px 0 0;padding:0;list-style:none;align-self:stretch;max-width:760px;}
  .pts li{position:relative;padding:0 0 0 40px;margin:26px 0;font-size:${Math.round(size * 0.5)}px;line-height:1.55;color:${fg};text-align:left;letter-spacing:1px;}
  .pts li:before{content:"";position:absolute;left:8px;top:.62em;width:10px;height:10px;border-radius:50%;background:${accent};}
</style></head><body><div class="wrap">
  <div class="rule"></div>
  <div class="t">${titleHtml}</div>
  ${hasPts ? `<ul class="pts">${points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
  ${sub ? `<div class="s">${esc(sub)}</div>` : ''}
</div></body></html>`;

const dir = mkdtempSync(path.join(tmpdir(), 'textcard-'));
const htmlPath = path.join(dir, 'card.html');
writeFileSync(htmlPath, html);

if (existsSync(out)) { try { unlinkSync(out); } catch {} }
const startedAt = Date.now();

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${dir}/prof`, '--hide-scrollbars', `--window-size=${W},${H}`,
  `--screenshot=${out}`, 'file://' + htmlPath,
], { stdio: 'ignore' });

const ok = await new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const done = existsSync(out) && statSync(out).size > 1000 && statSync(out).mtimeMs >= startedAt;
    if (done) { clearInterval(iv); resolve(true); }
    else if (Date.now() - t0 > 30000) { clearInterval(iv); resolve(false); }
  }, 300);
});
try { chrome.kill('SIGKILL'); } catch {}
if (!ok) { console.error('生成失败（超时）'); process.exit(1); }
console.log(out);
