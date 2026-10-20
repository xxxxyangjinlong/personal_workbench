import http from 'node:http';

// 1:1 reverse proxy for a local service: identical paths, HTTP + WebSocket.
export function makeProxyServer({ target, checkAuth }) {
  const server = http.createServer((req, res) => {
    if (!checkAuth(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const opts = { host: target.host, port: target.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: `${target.host}:${target.port}` } };
    const pr = http.request(opts, (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); });
    pr.on('error', () => { try { res.writeHead(502, { 'Content-Type': 'text/plain' }); } catch {} res.end('upstream unavailable'); });
    req.pipe(pr);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!checkAuth(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const opts = { host: target.host, port: target.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: `${target.host}:${target.port}` } };
    const pr = http.request(opts);
    pr.on('upgrade', (pres, psocket, phead) => {
      const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage || 'Switching Protocols'}`];
      for (const [k, v] of Object.entries(pres.headers)) lines.push(`${k}: ${v}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (phead && phead.length) socket.unshift(phead);
      psocket.pipe(socket); socket.pipe(psocket);
      if (head && head.length) psocket.write(head);
      psocket.on('error', () => socket.destroy());
      socket.on('error', () => psocket.destroy());
    });
    pr.on('error', () => socket.destroy());
    pr.end();
  });
  return server;
}
