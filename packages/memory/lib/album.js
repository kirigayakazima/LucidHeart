import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ALBUM_KINDS = Object.freeze(['video_storyboard', 'game_moment', 'user_photo']);
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = entry => `alb_${hash(JSON.stringify([entry.kind, entry.source_hash])).slice(0, 8)}`;
const text = (value, limit) => typeof value === 'string' && Boolean(value.trim()) && [...value].length <= limit;

function validate(entry) {
  return ALBUM_KINDS.includes(entry.kind) && /^[a-f0-9]{64}$/.test(entry.source_hash ?? '') &&
    entry.id === identity(entry) && Number.isFinite(Date.parse(entry.timestamp)) &&
    text(entry.title, 120) && text(entry.summary, 600) && typeof entry.user_quote === 'string' &&
    entry.user_quote.length <= 2000 && Array.isArray(entry.tags) && entry.tags.length <= 12 &&
    entry.tags.every(tag => text(tag, 40));
}

/** Independent append-only visual index. It never opens the fact journal. */
export class AlbumLedger {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'album.jsonl');
  }

  #read() {
    let content;
    try { content = fs.readFileSync(this.file, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (content && !content.endsWith('\n')) throw new Error('Incomplete album record');
    const entries = new Map();
    for (const [index, line] of content.split('\n').entries()) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { throw new Error(`Invalid album record at line ${index + 1}`); }
      if (!validate(entry) || entries.has(entry.id)) throw new Error(`Invalid album record at line ${index + 1}`);
      entries.set(entry.id, entry);
    }
    return [...entries.values()];
  }

  save({ media, source_hash, kind, title, summary, user_quote = '', tags = [], source, scope }, now = new Date()) {
    const entry = { timestamp: now.toISOString(), kind, title, summary,
      source_hash: Buffer.isBuffer(media) ? hash(media) : source_hash, user_quote, tags,
      ...(source && { source }), ...(scope && { scope }) };
    entry.id = identity(entry);
    if (!validate(entry)) throw new TypeError('Invalid visual album entry');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = this.file + '.lock';
    const guard = fs.openSync(lock, 'wx', 0o600);
    try {
      const existing = this.#read().find(item => item.id === entry.id);
      if (existing) {
        if (existing.source_hash !== entry.source_hash || existing.kind !== entry.kind || existing.scope !== entry.scope) {
          throw new Error('Album identity collision');
        }
        return { entry: existing, created: false };
      }
      const fd = fs.openSync(this.file, 'a', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(entry) + '\n', 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { entry, created: true };
    } finally {
      fs.closeSync(guard);
      fs.unlinkSync(lock);
    }
  }

  search(query = '', { after, before, limit = 5, scope } = {}) {
    if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new TypeError('Invalid album search');
    }
    const start = after === undefined ? -Infinity : Date.parse(after);
    const end = before === undefined ? Infinity : Date.parse(before);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) throw new TypeError('Invalid album time range');
    const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    return this.#read().filter(entry => (!scope || entry.scope === scope || entry.scope === 'shared') &&
      Date.parse(entry.timestamp) >= start && Date.parse(entry.timestamp) <= end)
      .map(entry => ({ entry, score: terms.filter(term =>
        [entry.title, entry.summary, entry.user_quote, ...entry.tags].join(' ').toLocaleLowerCase().includes(term)).length }))
      .filter(item => !terms.length || item.score > 0)
      .sort((a, b) => b.score - a.score || Date.parse(b.entry.timestamp) - Date.parse(a.entry.timestamp))
      .slice(0, limit).map(item => item.entry);
  }
}
