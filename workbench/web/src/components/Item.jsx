import React from 'react';
import Markdown from './Markdown.jsx';

const STATUS = {
  inProgress: { icon: '▶', cls: 'run', label: '进行中' },
  completed: { icon: '✓', cls: 'ok', label: '已完成' },
  failed: { icon: '✗', cls: 'err', label: '失败' },
  declined: { icon: '–', cls: 'skip', label: '已取消' },
  interrupted: { icon: '–', cls: 'skip', label: '已中断' },
};

function fmtMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${Math.round(s % 60)}秒`;
}

function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((o) => (typeof o === 'string' ? o : o?.text || '')).join('\n');
  }
  return JSON.stringify(output, null, 2);
}

export default function Item({ item }) {
  if (!item || !item.type) return null;

  if (item.type === 'userMessage') {
    const text = (item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return <div className="msg user"><Markdown text={text} /></div>;
  }

  if (item.type === 'agentMessage') {
    return <div className="msg agent"><Markdown text={item.text} /></div>;
  }

  if (item.type === 'reasoning') {
    const txt = (item.summary || []).join('\n') || (item.content || []).join('\n');
    if (!txt) return null;
    return (
      <details className="step">
        <summary><span className="step-ico think">✦</span>思考</summary>
        <pre className="out">{txt}</pre>
      </details>
    );
  }

  if (item.type === 'commandExecution') {
    const st = STATUS[item.status] || { icon: '·', cls: '', label: item.status };
    const meta = [fmtMs(item.durationMs), item.exitCode != null ? `退出码 ${item.exitCode}` : ''].filter(Boolean).join(' · ');
    return (
      <details className="step">
        <summary>
          <span className={`step-ico ${st.cls}`}>{st.icon}</span>
          <span className="cmd">{item.command}</span>
          <span className="meta">{meta}</span>
        </summary>
        {item.aggregatedOutput && <pre className="out">{item.aggregatedOutput}</pre>}
      </details>
    );
  }

  if (item.type === 'functionCallOutput') {
    const txt = outputText(item.output);
    if (!txt) return null;
    return (
      <details className="step">
        <summary><span className="step-ico ok">✓</span>{item.name || '输出'}</summary>
        <pre className="out">{txt}</pre>
      </details>
    );
  }

  if (item.type === 'plan') {
    return (
      <details className="step">
        <summary><span className="step-ico">☰</span>计划</summary>
        <pre className="out">{item.text}</pre>
      </details>
    );
  }

  if (item.type === 'fileChange') {
    const st = STATUS[item.status] || { icon: '·', cls: '' };
    return (
      <details className="step">
        <summary><span className={`step-ico ${st.cls}`}>{st.icon}</span>修改文件 ({item.changes?.length || 0})</summary>
        <pre className="out">{(item.changes || []).map((c) => c.path || c.file || JSON.stringify(c)).join('\n')}</pre>
      </details>
    );
  }

  if (item.type === 'mcpToolCall') {
    const st = STATUS[item.status] || { icon: '·', cls: '' };
    return (
      <details className="step">
        <summary><span className={`step-ico ${st.cls}`}>{st.icon}</span>{item.server} · {item.tool}</summary>
        <pre className="out">{JSON.stringify(item.arguments ?? item.result ?? {}, null, 2)}</pre>
      </details>
    );
  }

  if (item.type === 'webSearch') {
    return <div className="step-line">🔍 搜索 {item.query || ''}</div>;
  }

  return <div className="step-line">{item.type}</div>;
}
