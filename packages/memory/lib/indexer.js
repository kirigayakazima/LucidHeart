/**
 * @dsh/memory - SQLite WAL & FTS5 High-Performance Search Index
 *
 * 核心机制：
 * 1. 使用 Node.js 22/24 内置的 `node:sqlite` (DatabaseSync)，零外部 npm C/C++ 依赖
 * 2. 启用 WAL 模式 (Write-Ahead Logging)，高并发读写不阻塞
 * 3. 使用 FTS5 虚拟表 + 二元分词索引，毫秒级模糊/全文召回
 * 4. 彻底物理隔离：仅 active 状态进入 FTS5；superseded/revoked 自动从全文索引剔除
 */

import { DatabaseSync } from 'node:sqlite';
import { tokenizeForFTS, buildFtsQuery, buildProjectionQuery } from './tokenizer.js';

const SHADOW_POOL = 24;
const MAX_SHADOW_JOBS = 8;
const DAY_MS = 86_400_000;
const unit = (value, fallback) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

function rankShadow(rows, at) {
  const strongest = Math.max(0, ...rows.map(row => -row.rank));
  return rows.map((row, index) => {
    const entry = JSON.parse(row.raw_json);
    const relevance = strongest > 0 ? unit(-row.rank / strongest, 0) : 0;
    const importance = unit(entry.salience?.importance ?? entry.importance, 0.5);
    const ageDays = (at - Date.parse(entry.updatedAt ?? entry.createdAt)) / DAY_MS;
    const recency = Number.isFinite(ageDays) ? 1 / (1 + Math.max(0, ageDays) / 30) : 0;
    const retention = entry.retentionClass === 'pinned' ? 1 : entry.retentionClass === 'stable' ? 0.5 : 0;
    const score = 0.75 * relevance + 0.15 * importance + 0.07 * recency + 0.03 * retention;
    return { id: entry.id, index, score, relevance, importance, recency, retention };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
}

export class MemoryIndexer {
  #ready = true;
  #generation = 0;
  #shadowJobs = new Set();
  /**
   * @param {string} dbPath 数据库路径，或 ':memory:' 用于内存沙盒测试
   */
  constructor(dbPath, { retrievalPolicy = 'fts', onShadowEvaluation } = {}) {
    if (!['fts', 'shadow'].includes(retrievalPolicy)) throw new Error('Invalid memory retrievalPolicy');
    this.dbPath = dbPath;
    this.retrievalPolicy = retrievalPolicy;
    this.onShadowEvaluation = onShadowEvaluation;
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  initSchema() {
    // 1. 基础配置：启用 WAL 模式加速并防锁
    if (this.dbPath !== ':memory:') {
      try {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
      } catch {
        // 部分内存或只读模式忽略
      }
    }

    // 2. 关系主表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        scope         TEXT NOT NULL,
        content       TEXT NOT NULL,
        confidence    REAL NOT NULL DEFAULT 1.0,
        valid_from    TEXT,
        valid_to      TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        supersedes_id TEXT,
        confirmed     INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        raw_json      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_id   TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        edge_type   TEXT NOT NULL,
        weight      REAL DEFAULT 1.0,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, edge_type)
      );
    `);

    // 3. FTS5 全文索引虚拟表
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(
        id UNINDEXED,
        content_tokens,
        tags_tokens,
        entities_tokens
      );
    `);
  }

  /**
   * 写入或更新一条记忆到索引
   * @param {any} entry
   */
  upsert(entry) {
    this.#generation++;
    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, kind, scope, content, confidence, valid_from, valid_to,
        status, supersedes_id, confirmed, created_at, updated_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        scope = excluded.scope,
        content = excluded.content,
        confidence = excluded.confidence,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        status = excluded.status,
        supersedes_id = excluded.supersedes_id,
        confirmed = excluded.confirmed,
        updated_at = excluded.updated_at,
        raw_json = excluded.raw_json;
    `);

    stmt.run(
      entry.id,
      entry.kind,
      entry.scope,
      entry.content,
      entry.confidence ?? 1.0,
      entry.validFrom || null,
      entry.validTo || null,
      entry.status,
      entry.supersedesId || null,
      entry.confirmed ? 1 : 0,
      entry.createdAt,
      entry.updatedAt,
      JSON.stringify(entry)
    );

    // 4. 同步更新 FTS5 虚拟表
    // 关键设计红线：非 active 状态（如 revoked 或 superseded）彻底从 FTS 索引抹除
    this.db.prepare('DELETE FROM fts_memories WHERE id = ?').run(entry.id);

    if (entry.status === 'active') {
      const contentTokens = tokenizeForFTS(entry.content);
      const tagsTokens = tokenizeForFTS((entry.tags || []).join(' '));
      const entitiesTokens = tokenizeForFTS((entry.entities || []).join(' '));

      this.db.prepare(`
        INSERT INTO fts_memories (id, content_tokens, tags_tokens, entities_tokens)
        VALUES (?, ?, ?, ?);
      `).run(entry.id, contentTokens, tagsTokens, entitiesTokens);
    }

    // 5. 若有覆盖关系，记录图谱边
    for (const id of entry.supersedesIds || (entry.supersedesId ? [entry.supersedesId] : [])) {
      this.db.prepare(`
        INSERT OR REPLACE INTO edges (source_id, target_id, edge_type, weight, created_at)
        VALUES (?, ?, 'supersedes', 1.0, ?);
      `).run(entry.id, id, entry.updatedAt || new Date().toISOString());
    }
  }

  /**
   * 按关键词与作用域检索记忆
   * @param {string} query
   * @param {Object} options
   * @param {'xiaoman_private'|'axing_private'|'shared'|'all'} [options.scope='all']
   * @param {string|string[]} [options.kind]
   * @param {number} [options.limit=5]
   * @param {boolean} [options.projection=false]
   * @param {boolean} [options.exactScope=false]
   * @returns {Array<any>}
   */
  search(query, { scope = 'all', kind, limit = 5, projection = false, exactScope = false, shadow = true } = {}) {
    this.#assertReady();
    const ftsQuery = projection ? buildProjectionQuery(query) : buildFtsQuery(query);
    if (!ftsQuery) return [];

    let sql = `
      SELECT m.raw_json, f.rank
      FROM fts_memories f
      JOIN memories m ON f.id = m.id
      WHERE fts_memories MATCH ?
        AND m.status = 'active'
    `;

    const params = [ftsQuery];

    if (scope && scope !== 'all') {
      if (exactScope || scope === 'shared') {
        sql += ` AND m.scope = ?`;
      } else {
        // 当前作用域只能看自身私有 + 双端共享
        sql += ` AND (m.scope = ? OR m.scope = 'shared')`;
      }
      params.push(scope);
    }

    if (kind) {
      const kinds = Array.isArray(kind) ? kind : [kind];
      sql += ` AND m.kind IN (${kinds.map(() => '?').join(', ')})`;
      params.push(...kinds);
    }

    sql += ` ORDER BY f.rank ASC, m.confidence DESC, m.created_at DESC LIMIT ?;`;
    params.push(limit);

    let entries;
    try {
      const rows = this.db.prepare(sql).all(...params);
      entries = rows.map((r) => JSON.parse(r.raw_json));
    } catch {
      return [];
    }
    if (shadow && this.retrievalPolicy === 'shadow' && entries.length && this.onShadowEvaluation) {
      try { this.#scheduleShadow(sql, params, entries.slice(0, SHADOW_POOL).map(({ id }) => id), projection); } catch {}
    }
    return entries;
  }

  #scheduleShadow(sql, params, baselineIds, projection) {
    if (this.#shadowJobs.size >= MAX_SHADOW_JOBS) return;
    const generation = this.#generation;
    const job = setImmediate(() => {
      this.#shadowJobs.delete(job);
      if (!this.#ready || generation !== this.#generation) return;
      try {
        const start = performance.now();
        const at = Date.now();
        const rows = this.db.prepare(sql).all(...params.slice(0, -1), SHADOW_POOL);
        const ranked = rankShadow(rows, at);
        const shadowIds = ranked.filter(row => row.relevance >= 0.6).slice(0, baselineIds.length).map(({ id }) => id);
        const logged = this.onShadowEvaluation({
          at: new Date(at).toISOString(), policyVersion: 'shadow-v1', surface: projection ? 'conversation' : 'recall',
          baselineIds, shadowIds, scores: ranked.map(({ index, ...score }) => score),
          elapsedMs: performance.now() - start,
        });
        void Promise.resolve(logged).catch(() => {});
      } catch {}
    });
    job.unref?.();
    this.#shadowJobs.add(job);
  }

  invalidate() {
    this.#ready = false;
    this.#generation++;
  }

  #assertReady() {
    if (!this.#ready) throw Object.assign(Error('Memory projection unavailable until journal replay succeeds'),
      { code: 'MEMORY_PROJECTION_UNAVAILABLE' });
  }

  /**
   * 按 ID 检索单条记忆 (无论是否 active)
   * @param {string} id
   * @returns {any|null}
   */
  getById(id) {
    this.#assertReady();
    const row = this.db.prepare('SELECT raw_json FROM memories WHERE id = ?').get(id);
    return row ? JSON.parse(row.raw_json) : null;
  }

  hasIntakeMatch(content, scope, candidate) {
    this.#assertReady();
    return !!this.db.prepare(`
      SELECT 1 FROM memories
      WHERE content = ? AND scope = ?
        AND (status IN ('active', 'revoked') OR (? AND status = 'candidate'))
      LIMIT 1
    `).get(content, scope, Number(candidate));
  }

  /**
   * 获取所有活跃记忆条目
   * @returns {Array<any>}
   */
  getAllActive() {
    this.#assertReady();
    const rows = this.db.prepare("SELECT raw_json FROM memories WHERE status = 'active' ORDER BY created_at ASC").all();
    return rows.map((r) => JSON.parse(r.raw_json));
  }

  transaction(write) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      write();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  upsertAll(entries) {
    this.transaction(() => {
      for (const entry of entries) this.upsert(entry);
    });
  }

  /**
   * 重建全量索引 (从所有 Map 条目中重构 SQLite)
   * @param {Iterable<any>} entries
   */
  rebuildIndex(entries) {
    this.invalidate();
    this.transaction(() => {
      this.db.exec('DELETE FROM fts_memories; DELETE FROM memories; DELETE FROM edges;');
      for (const entry of entries) this.upsert(entry);
    });
    this.#ready = true;
  }

  close() {
    this.invalidate();
    for (const job of this.#shadowJobs) clearImmediate(job);
    this.#shadowJobs.clear();
    try {
      this.db.close();
    } catch {}
  }
}
