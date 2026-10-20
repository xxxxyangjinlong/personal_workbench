#!/usr/bin/env node
// 生成「纯文字卡片」封面图（中文字体本地渲染，不会有 AI 生成的乱码字）。
// 用法：
//   node textcard.mjs --text "你们公司团建要自费吗？" [--sub "说说你的经历"] [--out /path/a.png]
//                    [--theme light|dark] [--size 1080x1440]
import { writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
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
const theme = arg('theme', 'light');
const [W, H] = (arg('size', '1080x1440')).split('x').map(Number);
const out = path.resolve(arg('out', path.join(tmpdir(), `textcard-${Date.now()}.png`)));

// 字数越多字号越小
const n = Math.max(text.length, sub.length * 1.2);
const size = n <= 8 ? 132 : n <= 12 ? 116 : n <= 18 ? 96 : n <= 28 ? 78 : n <= 40 ? 64 : 54;
const dark = theme === 'dark';
const bg = dark ? '#101014' : '#ffffff';
const fg = dark ? '#f5f5f7' : '#141418';
const subFg = dark ? 'rgba(245,245,247,.55)' : 'rgba(20,20,24,.45)';
const accent = dark ? 'rgba(245,245,247,.14)' : 'rgba(20,20,24,.10)';

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${W}px;height:${H}px;background:${bg};}
  .wrap{width:${W}px;height:${H}px;display:flex;flex-direction:column;align-items:center;justify-content:center;
        padding:120px 96px;box-sizing:border-box;
        font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Heiti SC","Microsoft YaHei",sans-serif;}
  .rule{width:72px;height:6px;border-radius:3px;background:${accent};margin-bottom:56px;}
  .t{font-size:${size}px;line-height:1.5;font-weight:600;color:${fg};text-align:center;letter-spacing:1px;word-break:break-word;}
  .s{margin-top:48px;font-size:${Math.round(size * 0.42)}px;line-height:1.5;color:${subFg};text-align:center;letter-spacing:1px;}
</style></head><body><div class="wrap">
  <div class="rule"></div>
  <div class="t">${esc(text)}</div>
  ${sub ? `<div class="s">${esc(sub)}</div>` : ''}
</div></body></html>`;

const dir = mkdtempSync(path.join(tmpdir(), 'textcard-'));
const htmlPath = path.join(dir, 'card.html');
writeFileSync(htmlPath, html);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${dir}/prof`, '--hide-scrollbars', `--window-size=${W},${H}`,
  `--screenshot=${out}`, 'file://' + htmlPath,
], { stdio: 'ignore' });

const ok = await new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const done = existsSync(out) && statSync(out).size > 1000;
    if (done) { clearInterval(iv); resolve(true); }
    else if (Date.now() - t0 > 30000) { clearInterval(iv); resolve(false); }
  }, 300);
});
try { chrome.kill('SIGKILL'); } catch {}
if (!ok) { console.error('生成失败（超时）'); process.exit(1); }
console.log(out);
