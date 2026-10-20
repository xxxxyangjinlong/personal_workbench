import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { placeCall, VOICE_PROVIDER } from './voice.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'alarms.json');

function load() { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; } }
function save(list) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(list, null, 2)); }

export function list() { return load(); }

export function add(a = {}) {
  const list = load();
  const days = Array.isArray(a.days) && a.days.length ? a.days.filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6];
  const item = {
    id: randomUUID(),
    time: a.time,
    to: String(a.to || '').trim(),
    label: (a.label || '起床闹钟').trim(),
    message: (a.message || '').trim(),
    days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    enabled: a.enabled !== false,
    createdAt: Math.floor(Date.now() / 1000),
    lastFired: null,
  };
  list.push(item);
  save(list);
  return item;
}

export function update(id, patch = {}) {
  const list = load();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const allowed = ['time', 'to', 'label', 'message', 'days', 'enabled'];
  for (const k of allowed) if (k in patch) list[i][k] = patch[k];
  save(list);
  return list[i];
}

export function remove(id) {
  const list = load();
  const next = list.filter((x) => x.id !== id);
  save(next);
  return next.length !== list.length;
}

export function fire(alarm) {
  const msg = alarm.message || `${alarm.label || ''}，起床啦！`.replace(/^，/, '');
  return placeCall({ to: alarm.to, message: msg });
}

let timer = null;
export function startScheduler() {
  if (timer) return;
  const tick = async () => {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${hm}`;
    const dow = now.getDay();
    const all = load();
    let changed = false;
    for (const a of all) {
      if (!a.enabled || a.time !== hm) continue;
      if (Array.isArray(a.days) && a.days.length && !a.days.includes(dow)) continue;
      if (a.lastFired === stamp) continue;
      a.lastFired = stamp;
      changed = true;
      try {
        const r = await fire(a);
        console.log(`[alarm] ${a.time} 触发 -> ${a.to}（${r.provider}${r.mocked ? ' 模拟' : ''}）`);
      } catch (e) {
        console.error(`[alarm] 触发失败: ${e.message}`);
      }
    }
    if (changed) save(all);
  };
  timer = setInterval(tick, 20000);
  console.log(`[alarm] 调度已启动（provider: ${VOICE_PROVIDER}）`);
}
