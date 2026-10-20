import React, { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import { getToken } from '../api';

marked.setOptions({ gfm: true, breaks: true });

// 把模型输出（Markdown）渲染成 HTML：marked 解析 -> DOMPurify 消毒 -> 代码块高亮 + 复制按钮。
export default function Markdown({ text }) {
  const ref = useRef(null);

  const html = useMemo(() => {
    const src = String(text ?? '');
    if (!src) return '';
    let out;
    try { out = marked.parse(src); } catch { return ''; }
    if (typeof out !== 'string') out = String(out);
    return DOMPurify.sanitize(out);
  }, [text]);

  // 消毒之后再对代码块做高亮（hljs 会转义代码内容）并挂上复制按钮。
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // 本机绝对路径的图片（如 /tmp/x.png、~/shot.png）网关不直接暴露，
    // 改写为 /api/localimage?path=... 才能显示。
    for (const img of root.querySelectorAll('img')) {
      const raw = (img.getAttribute('src') || '').replace(/^file:\/\//, '');
      if (!raw || /^(https?:)?\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('/api/')) continue;
      if (!(raw.startsWith('/') || raw.startsWith('~'))) continue;
      const t = getToken();
      img.setAttribute('src', `/api/localimage?path=${encodeURIComponent(raw)}${t ? `&token=${encodeURIComponent(t)}` : ''}`);
    }
    for (const pre of root.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (code && !code.dataset.hl) {
        code.dataset.hl = '1';
        try { hljs.highlightElement(code); } catch { /* 忽略未知语言 */ }
      }
      if (pre.querySelector(':scope > .md-copy')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'md-copy';
      btn.textContent = '复制';
      btn.addEventListener('click', async () => {
        const src = code ? code.innerText : pre.innerText;
        try { await navigator.clipboard.writeText(src); btn.textContent = '已复制'; }
        catch { btn.textContent = '复制失败'; }
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      });
      pre.appendChild(btn);
    }
  }, [html]);

  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}
