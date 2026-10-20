import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BINS = ['/opt/homebrew/bin/ttyd', '/usr/local/bin/ttyd', '/usr/bin/ttyd'];

export function startTtyd({ port, basePath, session }) {
  const bin = BINS.find((p) => existsSync(p)) || 'ttyd';
  const args = ['-i', '127.0.0.1', '-p', String(port), '-b', basePath, '-W', 'tmux', 'new', '-A', '-s', session];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write('[ttyd] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[ttyd] ' + d));
  child.on('error', (err) => console.error('[ttyd] failed:', err.message));
  child.on('exit', (code, sig) => console.log('[ttyd] exited', code, sig));
  return child;
}
