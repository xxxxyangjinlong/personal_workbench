// 从本机各 git 仓库采集最近的提交，供「代码日常」帖取材。
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DEVLOG_ROOTS } from './config.mjs';

function findRepos(root, maxDepth = 4) {
  const out = [];
  const skip = new Set(['node_modules', 'target', 'build', 'dist', 'out', '.git']);
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isDirectory() && e.name === '.git')) { out.push(dir); return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** 采集 since（git 语法，如 midnight / '3 days ago'）以来各仓库的提交 */
export function collectCommits({ since = 'midnight', limit = 40 } = {}) {
  const repos = [];
  for (const root of DEVLOG_ROOTS) {
    if (!existsSync(root)) continue;
    for (const r of findRepos(root)) repos.push(r);
  }
  const commits = [];
  for (const repo of repos) {
    let out = '';
    try {
      out = execFileSync('git', ['-C', repo, 'log', `--since=${since}`, '--pretty=%h\t%ad\t%s', '--date=format:%m-%d %H:%M'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { continue; }
    for (const line of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      const [hash, time, subject] = line.split('\t');
      commits.push({ repo: path.basename(repo), hash, time, subject: subject || '' });
    }
  }
  commits.sort((a, b) => (a.time < b.time ? 1 : -1));
  return { repoCount: repos.length, commits: commits.slice(0, limit) };
}

/** 把文本里的仓库名/URL/长哈希抠掉，降低泄露内部信息的风险（提示词里还会再次强调） */
export function anonymize(text, names = []) {
  let s = String(text || '');
  for (const n of names) { if (n && n.length > 2) s = s.split(n).join('本项目'); }
  s = s.replace(/https?:\/\/\S+/g, '').replace(/\b[0-9a-f]{7,40}\b/g, '');
  return s.trim();
}
