/**
 * @dsh/memory - Unified Cognitive Memory Service
 */

import path from 'node:path';
import { generateMemoryId, supersedeMemory, validateMemoryEntry } from './types.js';
import { MemoryStore } from './store.js';
import { MemoryIndexer } from './indexer.js';
import { formatCompactOutline } from './budget.js';
import { projectConversation } from './projection.js';
import { isCandidateOrigin } from './schema.js';
import { CommitmentLedger } from './commitments.js';
import { ProjectLedger } from './projects.js';
import { findContradictions } from './contradictions.js';

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
    this.commitments = new CommitmentLedger(this.store);
    this.projects = new ProjectLedger(this.store);
    this.indexer = new MemoryIndexer(dbPath || path.join(dataDir, 'index.db'));
    try {
      this.initFromStore();
    } catch (error) {
      this.indexer.close();
      throw error;
    }
  }

  /**
   * 从真源日志初始化或同步索引
   */
  initFromStore() {
    this.reindex();
  }

  ensureProjections() {
    if (this.projectionsDirty) this.reindex();
  }

  commit(entry, action, { previous = [], reason } = {}) {
    this.projectionsDirty = true;
    this.store.appendJournal(entry, action, reason);
    this.indexer.upsertAll([...previous, entry]);
    if (entry.status !== 'candidate' || previous.length) {
      this.store.syncMarkdownView(this.indexer.getAllActive());
    }
    this.projectionsDirty = false;
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
   * @param {import('./types.js').MemoryProvenance} [params.provenance]
   * @param {number} [params.importance]
   * @param {string[]} [params.tags]
   * @param {string[]} [params.entities]
   * @returns {any}
   */
  remember(params = {}) {
    return this.#remember(params);
  }

  intake(params) {
    this.ensureProjections();
    const candidate = isCandidateOrigin(params.provenance?.origin);
    if (this.indexer.hasIntakeMatch(params.content, params.scope, candidate)) return;
    return this.#remember(params, true);
  }

  #remember({
    content,
    kind = 'fact',
    scope = 'xiaoman_private',
    confidence = 1.0,
    confirmed = false,
    validFrom,
    supersedesId,
    source = {},
    provenance,
    importance,
    tags = [],
    entities = [],
  }, autoCorrect = false) {
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Memory content must not be empty');
    }

    const now = new Date().toISOString();
    // 置信度低于 0.6 且未经用户明确确认的，进入 candidate 状态 (不进入检索索引)
    const inferred = isCandidateOrigin(provenance?.origin);
    const status = !inferred && (confidence >= 0.6 || confirmed) ? 'active' : 'candidate';

    const entry = {
      id: generateMemoryId(kind),
      kind,
      scope,
      content: content.trim(),
      confidence,
      ...(provenance !== undefined && { provenance }),
      ...(importance !== undefined && { importance }),
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
      confirmed: !inferred && !!confirmed,
      tags: Array.isArray(tags) ? tags : [],
      entities: Array.isArray(entities) ? entities : [],
      createdAt: now,
      updatedAt: now,
    };

    if (!validateMemoryEntry(entry)) {
      throw new Error('Invalid MemoryEntry structure');
    }

    // 一条 supersede 事件同时记录新事实和旧事实的失效关系。
    this.ensureProjections();
    let targets = [];
    if (supersedesId) {
      const old = this.indexer.getById(supersedesId);
      if (old?.status !== 'active') {
        throw new Error(`Target memory ${supersedesId} is not active`);
      }
      targets = [old];
    } else if (autoCorrect) {
      targets = findContradictions(entry, this.indexer);
      const spokenAt = Date.parse(entry.provenance?.timestamp);
      if (targets.some((old) => Date.parse(old.provenance?.timestamp) > spokenAt)) return;
      entry.supersedesId = targets[0]?.id || null;
      if (targets.length > 1) entry.supersedesIds = targets.map(({ id }) => id);
    }

    const previous = targets.map((old) => supersedeMemory(old, entry.id, now));
    this.commit(entry, previous.length ? 'supersede' : 'create', { previous });
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
    this.ensureProjections();
    const rawMatches = this.indexer.search(query, { scope, limit });
    const formatted = formatCompactOutline(rawMatches, { maxTokens });
    return {
      text: formatted.text,
      entries: rawMatches.slice(0, formatted.count),
      count: formatted.count,
      usedTokens: formatted.usedTokens,
    };
  }

  project(query, { scope = 'all', label } = {}) {
    this.ensureProjections();
    return projectConversation(this.indexer, query, { scope, label });
  }

  /**
   * 细查某条记忆的完整证据与版本链 (渐进式披露展开)
   * @param {string} id
   * @returns {any|null}
   */
  inspect(id) {
    this.ensureProjections();
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
    const target = this.inspect(targetId);
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
   * @param {{reason?: string}} [options]
   * @returns {boolean}
   */
  revoke(id, { reason } = {}) {
    const existing = this.inspect(id);
    if (!existing) return false;
    if (existing.status === 'revoked') return true;

    existing.status = 'revoked';
    existing.updatedAt = new Date().toISOString();
    existing.validTo ??= existing.updatedAt;
    this.commit(existing, 'revoke', { reason });
    return true;
  }

  /**
   * 从真源纯文本全量重建索引 (灾难恢复)
   * @returns {{ restoredCount: number, durationMs: number }}
   */
  reindex() {
    const t0 = Date.now();
    this.projectionsDirty = true;
    const commitments = new Map();
    const projects = new Map();
    const entries = this.store.loadAllFromJournal(commitments, projects);
    this.projects.entries = projects;
    this.indexer.rebuildIndex(entries.values());
    this.store.syncMarkdownView(this.indexer.getAllActive());
    this.commitments.entries = commitments;
    this.projectionsDirty = false;
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
