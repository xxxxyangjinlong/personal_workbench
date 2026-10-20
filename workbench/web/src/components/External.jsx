import React from 'react';

export default function External({ service, onBack }) {
  const url = `${location.protocol}//${location.hostname}:${service.port}${service.entry || '/'}`;
  return (
    <div className="page terminal">
      <header className="topbar">
        <button className="icon" onClick={onBack}>←</button>
        <span className="title small">{service.label}</span>
        <div className="spacer" />
        <a className="btnlink" href={url} target="_blank" rel="noreferrer">新窗口</a>
      </header>
      <iframe className="termframe" src={url} title={service.label} />
    </div>
  );
}
