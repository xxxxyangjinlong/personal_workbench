import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('render error', err, info); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, fontFamily: 'ui-monospace, Menlo, monospace', whiteSpace: 'pre-wrap', color: '#b00' }}>
          {'页面出错：\n' + String(this.state.err?.stack || this.state.err)}
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <Boundary>
    <App />
  </Boundary>
);
