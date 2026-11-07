/**
 * @dsh/memory - Ground Truth Storage Layer (Plain Markdown & JSONL Journal)
 *
 * 核心设计哲学 (借鉴 tigerless-labs/agent-memory & Heart):
 * - JSONL 日志是唯一真源，Markdown 与 SQLite / FTS 都是派生视图
 */

import fs from 'node:fs';
import path from 'node:path';
import { supersedeMemory } from './types.js';

export class MemoryStore {
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
   * @param {'create'|'update'|'supersede'|'revoke'|'commitment'} action
   * @param {string} [reason]
   */
  appendJournal(entry, action = 'create', reason) {
    const record = {
      action,
      timestamp: entry.updatedAt || new Date().toISOString(),
      entry,
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    };
    const fd = fs.openSync(this.journalPath, 'a+', 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      const lastByte = Buffer.alloc(1);
      if (size) fs.readSync(fd, lastByte, 0, 1, size - 1);
      // 保留损坏的旧尾行，同时避免它吞掉下一条完整事件。
      const separator = size && lastByte[0] !== 10 ? '\n' : '';
      const data = Buffer.from(separator + JSON.stringify(record) + '\n');
      if (fs.writeSync(fd, data) !== data.length) throw new Error('Incomplete memory journal append');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * 从 JSONL 还原所有有效记忆条目 (回放状态机)
   * @returns {Map<string, any>}
   */
  loadAllFromJournal(commitments) {
    const entries = new Map();
    if (!fs.existsSync(this.journalPath)) return entries;

    const content = fs.readFileSync(this.journalPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const { action, entry } = record;
        if (!entry || !entry.id) continue;

        if (action === 'commitment') {
          commitments?.set(entry.id, entry);
        } else if (action === 'create' || action === 'update') {
          entries.set(entry.id, entry);
        } else if (action === 'supersede') {
          entries.set(entry.id, entry);
          for (const id of entry.supersedesIds || [entry.supersedesId]) {
            const old = entries.get(id);
            if (old?.status === 'active' ||
                (entry.status === 'active' && old?.status === 'superseded' && !old.supersededBy)) {
              const endedAt = entry.updatedAt || record.timestamp || old.updatedAt;
              entries.set(id, supersedeMemory(old, entry.id, endedAt));
            }
          }
        } else if (action === 'revoke') {
          const existing = entries.get(entry.id) || entry;
          const endedAt = entry.updatedAt || record.timestamp || existing.updatedAt;
          entries.set(entry.id, {
            ...existing,
            status: 'revoked',
            updatedAt: endedAt,
            validTo: entry.validTo || existing.validTo || endedAt,
          });
        }
      } catch {
        // 忽略单行日志异常，保证容灾性
      }
    }
    return entries;
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
      const date = (item.validFrom || item.createdAt || '').slice(0, 10);
      lines.push(`- ${date} ${scopeBadge} [${item.kind}] ${item.content} <!-- id:${item.id} -->`);
    }

    const tmpPath = `${this.factsPath}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmpPath, this.factsPath);
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
