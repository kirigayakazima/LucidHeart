import { randomBytes } from 'node:crypto';
import { tokenizeForFTS } from './tokenizer.js';
import { getZonedParts } from './store.js';

const day = 24 * 60 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function offsetAt(ms, timeZone) {
  const { year, month, day, hour, minute, second } = getZonedParts(new Date(ms), timeZone);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / 1000) * 1000;
}

function deadline(time = '', timeZone = 'Asia/Shanghai') {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(time);
  if (!match) return NaN;
  const date = new Date(match[1]);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return NaN;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(time)) return Date.parse(time);
  const wallTime = Date.parse(time.length === 10 ? `${time}T23:59:59.999Z` : `${time}Z`);
  return wallTime - offsetAt(wallTime - offsetAt(wallTime, timeZone), timeZone);
}

function promptTitle(entry) {
  return entry.title.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()
    .replace(/[{}\[\]]/g, (char) => ({ '{': '｛', '}': '｝', '[': '［', ']': '］' })[char]);
}

export function formatCommitmentCare(entry) {
  return `[主动生活关怀背景: 你之前与对方约定了「${promptTitle(entry)}」（时间: ${entry.targetTime || '近日'}）。打招呼时请自然问起进展，语气亲昵贴心，不要像系统通知。]`;
}

function reminder(entry) {
  const prefix = '[待续接的约定: ';
  const time = entry.targetTime.length === 10 ? entry.targetTime.slice(5) : dateFormat.format(deadline(entry.targetTime));
  const title = promptTitle(entry);
  const text = `${entry.status === 'expired' ? '逾期 ' : ''}${time} ${title}`;
  const available = 40 - prefix.length - 1;
  const shortened = text.length <= available ? text : text.slice(0, available - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
  return `${prefix}${shortened}]`;
}

export class CommitmentLedger {
  constructor(store, ensureCurrent = () => {}) {
    this.store = store;
    this.ensureCurrent = ensureCurrent;
    this.entries = new Map();
  }

  #append(entry, note) {
    try {
      this.store.appendJournal(entry, 'commitment', note);
    } catch (error) {
      // 写入成功但刷盘报错时，以实际可重放的事件为准，重试不会重复登记或核销。
      try { this.store.loadAllFromJournal(this.entries); } catch {}
      throw error;
    }
    this.entries.set(entry.id, entry);
  }

  get(id, now = Date.now(), timeZone = 'Asia/Shanghai') {
    this.ensureCurrent();
    const entry = this.entries.get(id);
    if (!entry) return;
    const expired = entry.status === 'pending' && deadline(entry.targetTime, timeZone) < now;
    return { ...entry, status: expired ? 'expired' : entry.status };
  }

  record({ title, targetTime, evidence, channel, initiator = 'user' }, now = Date.now()) {
    this.ensureCurrent();
    title = title?.trim().replace(/\s+/g, ' ');
    targetTime = targetTime?.trim() || undefined;
    evidence = evidence?.trim();
    if (!title || !evidence || !['direct', 'group'].includes(channel) || !['user', 'xiaoman'].includes(initiator)) {
      throw new Error('Invalid commitment');
    }
    for (const entry of this.entries.values()) {
      if (entry.status === 'pending' && entry.title === title && entry.targetTime === targetTime) {
        return this.get(entry.id, now);
      }
    }
    /** @type {import('./types.js').CommitmentEntry} */
    const entry = {
      id: `cmt_${now.toString(36)}_${randomBytes(4).toString('hex')}`,
      title, initiator, ...(targetTime && { targetTime }), status: 'pending',
      createdAt: new Date(now).toISOString(), evidence, channel,
    };
    this.#append(entry);
    return this.get(entry.id, now);
  }

  resolve(id, status, note, now = Date.now()) {
    if (!['fulfilled', 'cancelled'].includes(status)) throw new Error('Invalid commitment resolution');
    const entry = this.get(id, now);
    if (!entry || entry.status === status) return entry;
    if (!['pending', 'expired'].includes(entry.status)) return;
    entry.status = status;
    if (status === 'fulfilled') entry.fulfilledAt = new Date(now).toISOString();
    this.#append(entry, note);
    return { ...entry };
  }

  /** Prefer the nearest upcoming deadline in 24h, then the nearest overdue one. */
  getActiveCommitmentCare(now = new Date(), timeZone = 'Asia/Shanghai') {
    this.ensureCurrent();
    const at = now.getTime();
    let next;
    let overdue;
    let earliest = Infinity;
    let latestPast = -Infinity;
    for (const entry of this.entries.values()) {
      if (!['pending', 'expired'].includes(entry.status)) continue;
      const due = deadline(entry.targetTime, timeZone);
      if (due >= at && due <= at + day && due < earliest) {
        earliest = due;
        next = entry.id;
      } else if (due < at && due > latestPast) {
        latestPast = due;
        overdue = entry.id;
      }
    }
    const id = next || overdue;
    return id ? this.get(id, at, timeZone) : null;
  }

  project(now = Date.now()) {
    const entry = this.getActiveCommitmentCare(new Date(now));
    return entry ? reminder(entry) : '';
  }

  find(query) {
    this.ensureCurrent();
    const words = tokenizeForFTS(query);
    if (!words) return [];
    const terms = words.split(' ');
    const specific = terms.filter((term) => term.length > 1);
    const needles = specific.length ? specific : terms;
    const matches = [];
    for (const entry of this.entries.values()) {
      if (!['pending', 'expired'].includes(entry.status)) continue;
      const tokens = new Set(tokenizeForFTS(entry.title).split(' '));
      if (!needles.some((term) => tokens.has(term))) continue;
      matches.push(this.get(entry.id));
      if (matches.length === 3) break;
    }
    return matches;
  }
}
