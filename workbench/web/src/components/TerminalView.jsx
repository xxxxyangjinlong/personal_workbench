import React from 'react';

export default function TerminalView({ onBack }) {
  return (
    <div className="page terminal">
      <header className="topbar">
        <button className="icon" onClick={onBack}>←</button>
        <span className="title small">终端</span>
        <div className="spacer" />
        <a className="btnlink" href="/term/" target="_blank" rel="noreferrer">新窗口</a>
      </header>
      <iframe className="termframe" src="/term/" title="terminal" />
    </div>
  );
}
