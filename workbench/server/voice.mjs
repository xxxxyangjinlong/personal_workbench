// 到点“喊起床”的通道适配层。
// 付费（真打电话）：twilio / aliyun
// 免费（网络电话）：ifttt（IFTTT VoIP 呼叫手机）
// 免费（推送响铃）：bark / ntfy / serverchan / telegram
// 默认 mock：只记日志，不真的发。
export const VOICE_PROVIDER = (process.env.VOICE_PROVIDER || 'mock').toLowerCase();

export const KIND = ['twilio', 'aliyun'].includes(VOICE_PROVIDER) ? 'call'
  : VOICE_PROVIDER === 'ifttt' ? 'voip'
  : ['bark', 'ntfy', 'serverchan', 'telegram'].includes(VOICE_PROVIDER) ? 'push'
  : 'mock';

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

export async function placeCall({ to, message }) {
  const text = (message && String(message).trim()) || '起床啦，该起床了！';
  const p = VOICE_PROVIDER;
  if (p === 'twilio') return twilioCall({ to, text });
  if (p === 'aliyun') return aliyunCall({ to, text });
  if (p === 'ifttt') return ifttt({ text });
  if (p === 'bark') return bark({ text });
  if (p === 'ntfy') return ntfy({ text });
  if (p === 'serverchan') return serverchan({ text });
  if (p === 'telegram') return telegram({ text });
  console.log(`[voice:mock] ☎️ 呼叫 ${to || '(推送)'}，播报：「${text}」`);
  return { ok: true, provider: 'mock', mocked: true, to, text };
}

// ---------- 付费：真打电话 ----------
async function twilioCall({ to, text }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) throw new Error('缺少 TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM');
  const twiml = `<Response><Say language="zh-CN" voice="Polly.Zhiyu">${escapeXml(text)}</Say><Pause length="1"/><Say language="zh-CN" voice="Polly.Zhiyu">${escapeXml(text)}</Say></Response>`;
  const body = new URLSearchParams({ To: to, From: from, Twiml: twiml });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `twilio ${res.status}`);
  return { ok: true, provider: 'twilio', sid: data.sid, status: data.status };
}
async function aliyunCall() {
  throw new Error('阿里云语音通知尚未接入（需 AccessKey + 已审核的语音模板）。可先用免费的推送通道。');
}

// ---------- 免费：网络电话（IFTTT VoIP） ----------
// IFTTT Webhooks -> VoIP Calls「Call my device」：到点用网络电话呼叫你的手机并朗读内容。
// 个人可注册、免费；手机需装 IFTTT App。IFTTT_KEY 见 https://ifttt.com/maker_webhooks/settings
async function ifttt({ text }) {
  const key = process.env.IFTTT_KEY;
  const event = (process.env.IFTTT_EVENT || 'wakeup').trim();
  if (!key) throw new Error('缺少 IFTTT_KEY（在 ifttt.com/maker_webhooks/settings 获取）');
  const res = await fetch(`https://maker.ifttt.com/trigger/${encodeURIComponent(event)}/with/key/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value1: text, value2: '', value3: '' }),
  });
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`ifttt ${res.status}: ${bodyText.slice(0, 200)}`);
  return { ok: true, provider: 'ifttt', called: true, event };
}

// ---------- 免费：推送响铃 ----------
// Bark（iOS，免费，App Store 搜 “Bark”）：BARK_URL=https://api.day.app/<你的key>
async function bark({ text }) {
  const url = process.env.BARK_URL;
  if (!url) throw new Error('缺少 BARK_URL，例如 https://api.day.app/你的key');
  const base = url.replace(/\/+$/, '');
  const res = await fetch(`${base}/${encodeURIComponent('起床闹钟')}/${encodeURIComponent(text)}?level=critical&sound=alarm&group=wakeup`, { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code && data.code !== 200)) throw new Error(data.message || `bark ${res.status}`);
  return { ok: true, provider: 'bark', pushed: true };
}

// ntfy（Android/iOS，免费开源）：NTFY_URL=https://ntfy.sh/<你的topic>
async function ntfy({ text }) {
  const url = process.env.NTFY_URL;
  if (!url) throw new Error('缺少 NTFY_URL，例如 https://ntfy.sh/my-wakeup-topic');
  // HTTP 头只能是 ASCII，中文标题放正文里，避免 undici ByteString 报错
  const res = await fetch(url, { method: 'POST', headers: { Title: 'Wake Up', Priority: 'urgent', Tags: 'alarm_clock,bell' }, body: `⏰ 起床闹钟\n${text}` });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
  return { ok: true, provider: 'ntfy', pushed: true };
}

// Server酱（微信，免费额度）：SERVERCHAN_KEY=SCT...
async function serverchan({ text }) {
  const key = process.env.SERVERCHAN_KEY;
  if (!key) throw new Error('缺少 SERVERCHAN_KEY');
  const body = new URLSearchParams({ title: '起床闹钟', desp: text });
  const res = await fetch(`https://sctapi.ftqq.com/${key}.send`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code && data.code !== 0)) throw new Error(data.message || `serverchan ${res.status}`);
  return { ok: true, provider: 'serverchan', pushed: true };
}

// Telegram 机器人（免费）：TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
async function telegram({ text }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('缺少 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
  const body = new URLSearchParams({ chat_id: chatId, text: `⏰ 起床闹钟\n${text}`, disable_notification: 'false' });
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.description || `telegram ${res.status}`);
  return { ok: true, provider: 'telegram', pushed: true };
}
