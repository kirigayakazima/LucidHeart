import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isInjectedMessage, readQqUtterance } from './host-context.js';
import { shanghaiDay } from './store.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const limit = (value, size) => typeof value === 'string'
  ? [...value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()].slice(0, size).join('') : '';
const id = value => typeof value === 'string' && value.length <= 256 && value.trim() ? value : null;

export function continuityKey(identity) {
  const { channel, scope, targetId, speaker } = identity ?? {};
  if (!['direct', 'group'].includes(channel) || !/^[a-z_]+$/u.test(scope ?? '') ||
      !id(targetId) || (channel === 'group' && !id(speaker))) return null;
  return channel + '_' + scope + '_' + createHash('sha256').update(JSON.stringify([targetId, speaker ?? null])).digest('hex');
}

export function continuityIdentity(message, scope, sessionId) {
  if (message?.source?.kind !== 'user') return null;
  const qq = message.source.qq;
  if (!qq && !['group', 'direct'].includes(message.source.channel ?? 'direct')) return null;
  if (!qq && message.source.channel !== 'group' && id(sessionId)) {
    return { channel: 'direct', scope, targetId: `host:${sessionId}` };
  }
  if (!readQqUtterance(message)) return null;
  const channel = qq.channel;
  const targetId = id(qq.targetId ?? qq.groupId ?? qq.peerId);
  const speaker = id(qq.speakerId);
  // A legacy QQ envelope lacks a durable peer/sender ID. Never guess it from a display name.
  return continuityKey({ channel, scope, targetId, speaker })
    ? { channel, scope, targetId, speaker } : null;
}

function normalize(value) {
  const rows = (items, count, size) => (Array.isArray(items) ? items : [])
    .map(item => limit(item, size)).filter(Boolean).slice(-count);
  return {
    current_focus: rows(value.current_focus, 2, 42),
    recent_media: (Array.isArray(value.recent_media) ? value.recent_media : []).flatMap(item => {
      const title = limit(item?.title, 36);
      const albumId = /^alb_[a-f0-9]{8}$/u.test(item?.albumId ?? '') ? item.albumId : undefined;
      return title ? [{ title, ...(albumId && { albumId }) }] : [];
    }).slice(-2),
    open_threads: rows(value.open_threads, 2, 42),
    recent_exchanges: rows(value.recent_exchanges, 3, 60),
  };
}

export function renderWorkingMemory(value) {
  const memory = normalize(value);
  const labels = [
    ['近况', memory.recent_exchanges],
    ['焦点', memory.current_focus],
    ['共看', memory.recent_media.map(item => item.albumId ? `${item.title} (${item.albumId})` : item.title)],
    ['待续', memory.open_threads],
  ];
  const header = '[近期工作记忆，仅作参考]\n';
  const footer = '[工作记忆结束]\n\n';
  const lines = labels.flatMap(([label, items]) => [...items].reverse().map(item => `- ${label} ${item}\n`));
  // Byte bound is conservative for byte-level provider tokenizers, including emoji.
  let body = '';
  for (const line of lines) if (Buffer.byteLength(header + body + line + footer) <= 800) body += line;
  return body ? header + body + footer : '';
}

function atomicWrite(file, body) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, body, { mode: 0o600, flag: 'wx', flush: true });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

export class WorkingMemory {
  constructor(dataDir, now = Date.now) {
    this.dataDir = dataDir;
    this.directory = path.join(dataDir, 'working_memory');
    this.now = now;
  }

  load(identity) {
    const key = continuityKey(identity);
    if (!key) return null;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.directory, key + '.json'), 'utf8'));
      const age = this.now() - data.updatedAt;
      return data.key === key && age >= 0 && age < TTL_MS ? normalize(data) : null;
    } catch { return null; }
  }

  save(identity, update) {
    const key = continuityKey(identity);
    if (!key) return null;
    const data = normalize({ ...this.load(identity), ...update });
    const rendered = renderWorkingMemory(data);
    if (!rendered) return null;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(this.directory, key + '.json'), JSON.stringify({ ...data, key, updatedAt: this.now() }));
    atomicWrite(path.join(this.directory, key + '.md'), rendered);
    return data;
  }
}

const text = message => Array.isArray(message?.content)
  ? message.content.filter(block => block.type === 'text').map(block => block.text).join(' ') : '';

export function collectExchanges(events, matches) {
  let current;
  const recent = [];
  for (const event of events) {
    if (event.type === 'turn/start') current = null;
    const message = event.data?.message ?? event.data;
    if (event.type === 'user/message' && !isInjectedMessage(message)) {
      const accepted = matches(message);
      const raw = message?.source?.qq ? readQqUtterance(message)?.text : text(message)
        .replace(/^(?:\[(?:近期工作记忆|近几日直聊片段|交接线索|上次语音被打断)[\s\S]*?\n\n)+/u, '')
        .replace(/^\[Voice message\]\s*/u, '');
      current = accepted && raw ? { user: raw, assistant: '', messageId: message.id } : null;
    }
    if (event.type === 'assistant/message' && current && !event.data?.interrupted && text(message)) {
      current.assistant = text(message);
    }
    if (event.type === 'turn/end') {
      if (current && (!event.data?.reason || event.data.reason.kind === 'completed')) {
        recent.push(current);
        if (recent.length > 3) recent.shift();
      }
      current = null;
    }
  }
  return recent;
}

export function workingExchanges(exchanges) {
  return exchanges.map(item => item.assistant
    ? `${limit(item.user, 28)} / ${limit(item.assistant, 29)}` : limit(item.user, 60));
}

export function saveDailyEpisode(dataDir, identity, { exchanges = [], focus = [] } = {}, now = Date.now()) {
  if (!dataDir || identity?.channel !== 'direct') return null;
  const cleanExchanges = (Array.isArray(exchanges) ? exchanges : []).map(item => limit(item, 80)).filter(Boolean).slice(-3);
  const cleanFocus = (Array.isArray(focus) ? focus : []).map(item => limit(item, 42)).filter(Boolean).slice(-2);
  if (!cleanExchanges.length && !cleanFocus.length) return null;
  const day = shanghaiDay(new Date(now));
  const dir = path.join(dataDir, 'episodes');
  const file = path.join(dir, `${day}.jsonl`);
  const signature = JSON.stringify({
    scope: identity.scope ?? null,
    targetId: identity.targetId ?? null,
    exchanges: cleanExchanges,
    focus: cleanFocus,
  });
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const prevSig = JSON.stringify({
            scope: parsed.scope ?? null,
            targetId: parsed.targetId ?? null,
            exchanges: parsed.exchanges ?? [],
            focus: parsed.focus ?? [],
          });
          if (prevSig === signature) return null;
        } catch {}
      }
    }
  } catch {}
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = {
    day,
    time: new Date(now).toISOString(),
    scope: identity.scope,
    targetId: identity.targetId,
    focus: cleanFocus,
    exchanges: cleanExchanges,
  };
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  return record;
}

export function renderRecentEpisodes(dataDir, identity, { days = 5, maxBytes = 600, now = Date.now() } = {}) {
  if (!dataDir || identity?.channel !== 'direct') return '';
  const dir = path.join(dataDir, 'episodes');
  if (!fs.existsSync(dir)) return '';
  const seen = new Set();
  const entries = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = shanghaiDay(new Date(now - offset * 86_400_000));
    const file = path.join(dir, `${day}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const item = JSON.parse(lines[i]);
        if (identity.scope && item.scope && item.scope !== identity.scope) continue;
        const itemTarget = String(item.targetId ?? '');
        const idTarget = String(identity.targetId ?? '');
        if (itemTarget && idTarget && !itemTarget.startsWith('host:') && !idTarget.startsWith('host:') && itemTarget !== idTarget) {
          continue;
        }
        const rows = [...(Array.isArray(item.exchanges) ? item.exchanges : [])].reverse();
        for (const ex of rows) {
          const clean = limit(ex, 80);
          if (!clean || seen.has(clean)) continue;
          seen.add(clean);
          entries.push({ day: item.day || day, text: clean });
        }
      } catch {}
    }
  }
  if (!entries.length) return '';
  const header = '[近几日直聊片段，仅作参考]\n';
  const footer = '[直聊片段结束]\n\n';
  let body = '';
  for (const entry of entries) {
    const line = `- ${entry.day} ${entry.text}\n`;
    if (Buffer.byteLength(header + body + line + footer) <= maxBytes) body += line;
  }
  return body ? header + body + footer : '';
}
