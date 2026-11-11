/**
 * @dsh/memory - Ground Truth Storage Layer (Plain Markdown & JSONL Journal)
 *
 * 核心设计哲学 (借鉴 tigerless-labs/agent-memory & Heart):
 * - JSONL 日志是唯一真源，Markdown 与 SQLite / FTS 都是派生视图
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CommitmentStatuses, supersedeMemory, validateMemoryEntry } from './types.js';

const LEGACY_ACTIONS = new Set(['create', 'update', 'supersede', 'revoke', 'commitment', 'project']);
const mutationDigest = record => createHash('sha256').update(JSON.stringify([
  record.mutationVersion, record.action, record.operationId, record.timestamp, record.replaces, record.entry,
])).digest('hex');
const legacyTargets = entry => entry.supersedesIds ?? (entry.supersedesId ? [entry.supersedesId] : []);
const revisionOf = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

export class JournalCorruptionError extends Error {
  constructor(line, reason) {
    super(`Memory journal is corrupt${line === null ? '' : ` at line ${line}`}: ${reason}`);
    this.name = 'JournalCorruptionError';
    this.code = 'MEMORY_JOURNAL_CORRUPT';
    this.line = line;
  }
}

function validateRecord(record) {
  if (!LEGACY_ACTIONS.has(record?.action) || !record.entry || typeof record.entry !== 'object' ||
      typeof record.entry.id !== 'string' || !record.entry.id.trim()) throw Error('invalid event envelope');
  if (record.action === 'supersede' && (!Array.isArray(legacyTargets(record.entry)) ||
      legacyTargets(record.entry).some(id => typeof id !== 'string' || !id))) throw Error('invalid replacement references');
}

function applyMutation(record, entries) {
  const { entry, replaces, operationId, timestamp } = record;
  if (record.action !== 'supersede' || record.mutationVersion !== 1 || operationId !== entry.id ||
      !validateMemoryEntry(entry) || entry.status !== 'active' || !Number.isFinite(Date.parse(timestamp)) ||
      timestamp !== entry.updatedAt || !Array.isArray(replaces) || !replaces.length ||
      new Set(replaces).size !== replaces.length || replaces[0] !== entry.supersedesId ||
      JSON.stringify(replaces) !== JSON.stringify(legacyTargets(entry)) || record.checksum !== mutationDigest(record)) {
    throw Error('invalid mutation or checksum');
  }
  if (entries.has(entry.id)) throw Error('duplicate mutation entry');
  if (replaces.some(id => entries.get(id)?.status !== 'active')) throw Error('mutation target is not active');
  for (const id of replaces) entries.set(id, supersedeMemory(entries.get(id), entry.id, timestamp));
  entries.set(entry.id, entry);
}

const zonedFormatters = new Map();

export function getZonedParts(date, timeZone = 'Asia/Shanghai') {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    zonedFormatters.set(timeZone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(date)
    .filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]));
}

export function shanghaiDay(date) {
  const { year, month, day } = getZonedParts(date, 'Asia/Shanghai');
  return [year, month, day].map(value => String(value).padStart(2, '0')).join('-');
}

export class MemoryStore {
  #verifiedRevision;
  #needsSync = false;
  #needsDirectorySync = false;
  /**
   * @param {string} rootDir 存储根目录，如 ~/.dsh/memory
   */
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.factsPath = path.join(rootDir, 'facts.md');
    this.journalPath = path.join(rootDir, 'journal.jsonl');
    this.episodesDir = path.join(rootDir, 'episodes');
    this.ensureDirs();
  }

  ensureDirs() {
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.episodesDir, { recursive: true });
  }

  /**
   * 追加一条记忆变更到日志流 (Append-only Journal)
   * @param {any} entry
   * @param {'create'|'update'|'supersede'|'revoke'|'commitment'|'project'} action
   * @param {string} [reason]
   */
  appendJournal(entry, action = 'create', reason, expectedRevision) {
    return this.#appendRecord({
      action,
      timestamp: entry.updatedAt || new Date().toISOString(),
      entry,
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    }, expectedRevision);
  }

  appendMutation(entry, replaces, expectedRevision) {
    const record = { action: 'supersede', mutationVersion: 1, operationId: entry.id,
      timestamp: entry.updatedAt, replaces: [...replaces], entry };
    record.checksum = mutationDigest(record);
    const state = this.replayJournal();
    if (expectedRevision !== undefined && state.revision !== expectedRevision) throw Error('Memory journal changed before mutation');
    applyMutation(record, state.entries);
    return this.#appendRecord(record, state.revision);
  }

  journalRevision() {
    try { return revisionOf(fs.statSync(this.journalPath, { bigint: true })); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #syncDirectory() {
    if (!this.#needsDirectorySync) return;
    const dir = fs.openSync(this.rootDir, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    this.#needsDirectorySync = false;
  }

  #appendRecord(record, expectedRevision) {
    validateRecord(record);
    const revision = this.journalRevision();
    if (expectedRevision !== undefined && expectedRevision !== revision) throw Error('Memory journal changed before mutation');
    if (this.#needsSync || revision !== this.#verifiedRevision) this.replayJournal();
    const fd = fs.openSync(this.journalPath, 'a+', 0o600);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (this.#verifiedRevision === null ? stat.size !== 0n : revisionOf(stat) !== this.#verifiedRevision) {
        throw Error('Memory journal changed before append');
      }
      const size = Number(stat.size);
      const lastByte = Buffer.alloc(1);
      if (size) fs.readSync(fd, lastByte, 0, 1, size - 1);
      const separator = size && lastByte[0] !== 10 ? '\n' : '';
      const data = Buffer.from(separator + JSON.stringify(record) + '\n');
      this.#needsSync = true;
      if (this.#verifiedRevision === null && process.platform !== 'win32') this.#needsDirectorySync = true;
      if (fs.writeSync(fd, data) !== data.length) throw new Error('Incomplete memory journal append');
      fs.fsyncSync(fd);
      this.#syncDirectory();
      this.#verifiedRevision = revisionOf(fs.fstatSync(fd, { bigint: true }));
      this.#needsSync = false;
      return this.#verifiedRevision;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * 从 JSONL 还原所有有效记忆条目 (回放状态机)
   * @returns {Map<string, any>}
   */
  loadAllFromJournal(commitments, projects) {
    const replay = this.replayJournal();
    for (const [target, staged] of [[commitments, replay.commitments], [projects, replay.projects]]) {
      if (!target) continue;
      target.clear();
      for (const [id, entry] of staged) target.set(id, entry);
    }
    return replay.entries;
  }

  replayJournal() {
    const entries = new Map();
    const commitments = new Map();
    const projects = new Map();
    const revision = this.journalRevision();
    const replay = { entries, commitments, projects, revision };
    if (revision === null && !this.#needsSync) {
      this.#verifiedRevision = null;
      return replay;
    }
    const bytes = fs.readFileSync(this.journalPath);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new JournalCorruptionError(null, 'invalid UTF-8'); }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const record = JSON.parse(lines[i]);
        validateRecord(record);
        const { action, entry } = record;
        if (record.mutationVersion !== undefined || record.replaces !== undefined) {
          if (i === lines.length - 1) throw Error('unterminated mutation');
          applyMutation(record, entries);
        } else if (action === 'commitment') {
          if (typeof entry.title !== 'string' || !CommitmentStatuses.includes(entry.status)) throw Error('invalid commitment');
          commitments.set(entry.id, entry);
        } else if (action === 'project') {
          if (typeof entry.title !== 'string' || !['active', 'completed', 'cancelled'].includes(entry.status)) {
            throw Error('invalid project');
          }
          projects.set(entry.id, entry);
        } else if (action === 'create' || action === 'update') {
          if (!validateMemoryEntry(entry)) throw Error('invalid memory entry');
          const previous = entries.get(entry.id);
          if (['superseded', 'revoked'].includes(previous?.status) && !['superseded', 'revoked'].includes(entry.status)) {
            throw Error('attempted reactivation of a retired entry');
          }
          entries.set(entry.id, entry);
        } else if (action === 'supersede') {
          if (!validateMemoryEntry(entry)) throw Error('invalid legacy replacement');
          if (entry.status === 'active' && ['superseded', 'revoked'].includes(entries.get(entry.id)?.status)) {
            throw Error('attempted reactivation of a retired entry');
          }
          entries.set(entry.id, entry);
          for (const id of legacyTargets(entry)) {
            const old = entries.get(id);
            if (old?.status === 'active' ||
                (entry.status === 'active' && old?.status === 'superseded' && !old.supersededBy)) {
              const endedAt = entry.updatedAt || record.timestamp || old.updatedAt;
              entries.set(id, supersedeMemory(old, entry.id, endedAt));
            }
          }
        } else if (action === 'revoke') {
          const existing = entries.get(entry.id) || entry;
          if (!validateMemoryEntry(existing)) throw Error('invalid revocation target');
          const endedAt = entry.updatedAt || record.timestamp || existing.updatedAt;
          entries.set(entry.id, {
            ...existing,
            status: 'revoked',
            updatedAt: endedAt,
            validTo: entry.validTo || existing.validTo || endedAt,
          });
        }
      } catch (error) {
        throw new JournalCorruptionError(i + 1, error instanceof SyntaxError ? 'invalid JSON' : error.message);
      }
    }
    if (this.journalRevision() !== revision) throw Error('Memory journal changed during replay');
    if (this.#needsSync) {
      const fd = fs.openSync(this.journalPath, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.#syncDirectory();
      this.#needsSync = false;
    }
    this.#verifiedRevision = revision;
    return replay;
  }

  /**
   * 同步刷新人类可读的 facts.md (只展示 active 状态的长期事实与偏好)
   * @param {Array<any>} activeEntries
   */
  syncMarkdownView(activeEntries) {
    const lines = [
      '# 记忆与事实清单 (Active Memory Facts)',
      '> 由 LucidMemory 自动维护，人类可读。每条记忆对应唯一 ID 与生效时间。',
      '',
    ];

    const sorted = [...activeEntries].sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));

    for (const item of sorted) {
      if (item.status !== 'active') continue;
      const scopeBadge = item.scope === 'shared' ? '[shared]' : `[${item.scope.replace('_private', '')}]`;
      const at = new Date(item.validFrom || item.createdAt || '');
      const date = Number.isFinite(at.getTime()) ? shanghaiDay(at) : '';
      lines.push(`- ${date} ${scopeBadge} [${item.kind}] ${item.content} <!-- id:${item.id} -->`);
    }

    const tmpPath = `${this.factsPath}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmpPath, this.factsPath);
  }

  appendShadowEvaluation(report) {
    const file = path.join(this.rootDir, 'shadow-retrieval.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size >= 256 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, JSON.stringify(report) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * 写入单日情节记录文件
   * @param {string} dateStr YYYY-MM-DD
   * @param {string} line
   */
  appendEpisode(dateStr, line) {
    const episodeFile = path.join(this.episodesDir, `${dateStr}.md`);
    fs.appendFileSync(episodeFile, line.trim() + '\n', 'utf8');
  }
}
