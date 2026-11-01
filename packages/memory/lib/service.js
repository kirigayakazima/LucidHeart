/**
 * @dsh/memory - Unified Cognitive Memory Service
 */

import path from 'node:path';
import { generateMemoryId, validateMemoryEntry } from './types.js';
import { MemoryStore } from './store.js';
import { MemoryIndexer } from './indexer.js';
import { formatCompactOutline } from './budget.js';

export class MemoryService {
  /**
   * @param {Object} options
   * @param {string} options.dataDir 存储根路径，如 ~/.dsh/memory
   * @param {string} [options.dbPath] SQLite路径，缺省为 dataDir/index.db
   */
  constructor({ dataDir, dbPath } = {}) {
    if (!dataDir) throw new Error('dataDir is required for MemoryService');
    this.dataDir = dataDir;
    this.store = new MemoryStore(dataDir);
    this.indexer = new MemoryIndexer(dbPath || path.join(dataDir, 'index.db'));
    this.initFromStore();
  }

  /**
   * 从真源日志初始化或同步索引
   */
  initFromStore() {
    const entries = this.store.loadAllFromJournal();
    if (entries.size > 0) {
      this.indexer.rebuildIndex(entries.values());
      this.store.syncMarkdownView(this.indexer.getAllActive());
    }
  }

  /**
   * 记录一条新记忆
   * @param {Object} params
   * @param {string} params.content
   * @param {'fact'|'episodic'|'preference'|'relationship'} [params.kind='fact']
   * @param {'xiaoman_private'|'axing_private'|'shared'} [params.scope='xiaoman_private']
   * @param {number} [params.confidence=1.0]
   * @param {boolean} [params.confirmed=false]
   * @param {string} [params.validFrom]
   * @param {string} [params.supersedesId]
   * @param {any} [params.source]
   * @param {string[]} [params.tags]
   * @param {string[]} [params.entities]
   * @returns {any}
   */
  remember({
    content,
    kind = 'fact',
    scope = 'xiaoman_private',
    confidence = 1.0,
    confirmed = false,
    validFrom,
    supersedesId,
    source = {},
    tags = [],
    entities = [],
  } = {}) {
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Memory content must not be empty');
    }

    const now = new Date().toISOString();
    // 置信度低于 0.6 且未经用户明确确认的，进入 candidate 状态 (不进入检索索引)
    const status = confidence >= 0.6 || confirmed ? 'active' : 'candidate';

    const entry = {
      id: generateMemoryId(kind),
      kind,
      scope,
      content: content.trim(),
      confidence,
      validFrom: validFrom || now,
      validTo: null,
      source: {
        sessionId: source.sessionId || 'unknown',
        device: source.device || 'phone',
        channel: source.channel || 'qq',
        evidenceText: source.evidenceText || '',
      },
      status,
      supersedesId: supersedesId || null,
      confirmed: !!confirmed,
      tags: Array.isArray(tags) ? tags : [],
      entities: Array.isArray(entities) ? entities : [],
      createdAt: now,
      updatedAt: now,
    };

    if (!validateMemoryEntry(entry)) {
      throw new Error('Invalid MemoryEntry structure');
    }

    // 1. 如果有前序覆盖项，将旧记忆置为 superseded
    if (supersedesId) {
      const old = this.indexer.getById(supersedesId);
      if (old && old.status === 'active') {
        old.status = 'superseded';
        old.updatedAt = now;
        old.validTo = now;
        this.store.appendJournal(old, 'supersede');
        this.indexer.upsert(old);
      }
    }

    // 2. 写入真源日志并同步索引
    this.store.appendJournal(entry, supersedesId ? 'supersede' : 'create');
    this.indexer.upsert(entry);

    if (entry.status === 'active') {
      this.store.syncMarkdownView(this.indexer.getAllActive());
    }

    return entry;
  }

  /**
   * 按关键词与作用域检索记忆并返回紧凑文本
   * @param {string} query
   * @param {Object} options
   * @param {'xiaoman_private'|'axing_private'|'shared'|'all'} [options.scope='all']
   * @param {number} [options.limit=5]
   * @param {number} [options.maxTokens=250]
   * @returns {{ text: string, entries: Array<any>, count: number, usedTokens: number }}
   */
  recall(query, { scope = 'all', limit = 5, maxTokens = 250 } = {}) {
    const rawMatches = this.indexer.search(query, { scope, limit });
    const formatted = formatCompactOutline(rawMatches, { maxTokens });
    return {
      text: formatted.text,
      entries: rawMatches.slice(0, formatted.count),
      count: formatted.count,
      usedTokens: formatted.usedTokens,
    };
  }

  /**
   * 细查某条记忆的完整证据与版本链 (渐进式披露展开)
   * @param {string} id
   * @returns {any|null}
   */
  inspect(id) {
    return this.indexer.getById(id);
  }

  /**
   * 纠错：声明新事实覆盖并废弃旧事实
   * @param {string} targetId
   * @param {string} newContent
   * @param {Object} options
   * @returns {any}
   */
  correct(targetId, newContent, options = {}) {
    const target = this.indexer.getById(targetId);
    if (!target) {
      throw new Error(`Target memory ${targetId} not found to correct`);
    }

    return this.remember({
      content: newContent,
      kind: options.kind || target.kind,
      scope: options.scope || target.scope,
      confidence: 1.0,
      confirmed: true,
      supersedesId: targetId,
      source: options.source || target.source,
      tags: options.tags || target.tags,
      entities: options.entities || target.entities,
    });
  }

  /**
   * 注销 / 遗忘记忆 (用户明确要求忘掉)
   * @param {string} id
   * @returns {boolean}
   */
  revoke(id) {
    const existing = this.indexer.getById(id);
    if (!existing) return false;

    existing.status = 'revoked';
    existing.updatedAt = new Date().toISOString();

    this.store.appendJournal(existing, 'revoke');
    this.indexer.upsert(existing);
    this.store.syncMarkdownView(this.indexer.getAllActive());
    return true;
  }

  /**
   * 从真源纯文本全量重建索引 (灾难恢复)
   * @returns {{ restoredCount: number, durationMs: number }}
   */
  reindex() {
    const t0 = Date.now();
    const entries = this.store.loadAllFromJournal();
    this.indexer.rebuildIndex(entries.values());
    this.store.syncMarkdownView(this.indexer.getAllActive());
    const durationMs = Date.now() - t0;
    return {
      restoredCount: entries.size,
      durationMs,
    };
  }

  close() {
    this.indexer.close();
  }
}
