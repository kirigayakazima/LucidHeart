/**
 * @dsh/memory - Ground Truth Storage Layer (Plain Markdown & JSONL Journal)
 *
 * 核心设计哲学 (借鉴 tigerless-labs/agent-memory & Heart):
 * - 人类肉眼可读的 Markdown 与结构化 JSONL 永远是唯一权威真源 (Source of Truth)
 * - 任何 SQLite / FTS 损坏，均可从本层 100% 无损重建
 */

import fs from 'node:fs';
import path from 'node:path';

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
   * @param {'create'|'update'|'supersede'|'revoke'} action
   */
  appendJournal(entry, action = 'create') {
    const record = {
      action,
      timestamp: new Date().toISOString(),
      entry,
    };
    fs.appendFileSync(this.journalPath, JSON.stringify(record) + '\n', 'utf8');
  }

  /**
   * 从 JSONL 还原所有有效记忆条目 (回放状态机)
   * @returns {Map<string, any>}
   */
  loadAllFromJournal() {
    const entries = new Map();
    if (!fs.existsSync(this.journalPath)) return entries;

    const content = fs.readFileSync(this.journalPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const { action, entry } = record;
        if (!entry || !entry.id) continue;

        if (action === 'create' || action === 'update') {
          entries.set(entry.id, entry);
        } else if (action === 'supersede') {
          entries.set(entry.id, entry);
          if (entry.supersedesId && entries.has(entry.supersedesId)) {
            const old = entries.get(entry.supersedesId);
            old.status = 'superseded';
            old.updatedAt = entry.updatedAt || new Date().toISOString();
          }
        } else if (action === 'revoke') {
          if (entries.has(entry.id)) {
            const existing = entries.get(entry.id);
            existing.status = 'revoked';
            existing.updatedAt = entry.updatedAt || new Date().toISOString();
          } else {
            entries.set(entry.id, { ...entry, status: 'revoked' });
          }
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
