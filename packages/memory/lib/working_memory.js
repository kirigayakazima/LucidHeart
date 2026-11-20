import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isInjectedMessage, readQqUtterance } from './host-context.js';

const TTL_MS = 24 * 60 * 60 * 1000;
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
        .replace(/^(?:\[(?:近期工作记忆|交接线索|上次语音被打断)[\s\S]*?\n\n)+/u, '')
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
