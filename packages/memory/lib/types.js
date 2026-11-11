import { ClaimTypes, ConversationChannels, EvidenceStatuses, IntakeWeights, ProvenanceOrigins, RetentionClasses } from './schema.js';

export { ClaimTypes, ProvenanceOrigins, RetentionClasses };

/** @typedef {'user_request'|'autonomous'|'external'|'unknown'} ProvenanceOrigin */
/** @typedef {'user_statement'|'observation'|'model_inference'|'legacy_unknown'} ClaimType */
/** @typedef {'stable'|'episodic'|'pinned'|'unknown'} RetentionClass */

/**
 * @dsh/memory - Core Types and Constants
 */

/**
 * 记忆分类
 * - fact: 客观稳定事实 (如: 主人是程序员、住在杭州)
 * - episodic: 情节事件经历 (如: 某天一起打游戏通关、某次聊天吵架)
 * - preference: 主观喜好习惯 (如: 喜欢喝冰红茶、不喜欢香菜)
 * - relationship: 核心关系与约定 (如: 姐妹身份认知、重要的纪念日承诺)
 */
export const MemoryKinds = ['fact', 'episodic', 'preference', 'relationship'];

/**
 * 记忆归属作用域
 * - xiaoman_private: 小满独立私密记忆 (仅手机端小满可见)
 * - axing_private: 阿醒独立私密记忆 (仅PC端阿醒可见)
 * - shared: 经显式授权的双端共享记忆
 */
export const MemoryScopes = ['xiaoman_private', 'axing_private', 'shared'];

/**
 * 记忆状态机
 * - candidate: 候选状态 (待确认/低置信度)
 * - active: 活跃生效状态 (正常参与检索与提示词装配)
 * - superseded: 已被新事实覆盖状态 (历史版本，保留用于溯源，默认检索不返回)
 * - revoked: 已彻底注销/遗忘状态 (用户要求删除，索引物理隔离)
 */
export const MemoryStatuses = /** @type {const} */ (['candidate', 'active', 'superseded', 'revoked']);

/** @typedef {typeof MemoryStatuses[number]} MemoryStatus */

export const CommitmentStatuses = /** @type {const} */ (['pending', 'fulfilled', 'expired', 'cancelled']);

/**
 * @typedef {Object} CommitmentEntry
 * @property {string} id
 * @property {string} title
 * @property {'user'|'xiaoman'} initiator
 * @property {string} [targetTime]
 * @property {typeof CommitmentStatuses[number]} status
 * @property {string} createdAt
 * @property {string} [fulfilledAt]
 * @property {string} evidence
 * @property {'direct'|'group'} channel
 */

export const MemoryOrigins = Object.keys(IntakeWeights);

export function supersedeMemory(previous, replacementId, endedAt) {
  return { ...previous, status: 'superseded', supersededBy: replacementId, updatedAt: endedAt, validTo: endedAt };
}

/**
 * @typedef {Object} LegacyMemoryProvenance
 * @property {'user_statement'|'shared_experience'|'casual_chat'|'model_inference'} origin
 * @property {string} speaker
 * @property {'direct'|'group'} channel
 * @property {string} timestamp ISO timestamp
 */

/**
 * @typedef {Object} SourceProvenance
 * @property {ProvenanceOrigin} origin
 * @property {ClaimType} claimType
 * @property {'resolved'|'unavailable'|'unknown'} [evidenceStatus]
 */
/** @typedef {LegacyMemoryProvenance|SourceProvenance} MemoryProvenance */

/**
 * @typedef {Object} MemorySource
 * @property {string} [sessionId]
 * @property {string} [device]
 * @property {string} [channel]
 * @property {string} [speaker]
 * @property {string} [messageId]
 * @property {string} [observedAt]
 * @property {string} [evidenceText]
 */

/**
 * @typedef {Object} MemorySalience
 * @property {number|null} importance
 * @property {string} [reason]
 * @property {string} [policyVersion]
 */

/**
 * @typedef {Object} MemoryEntry
 * @property {string} id
 * @property {string} kind
 * @property {string} scope
 * @property {string} content
 * @property {number} confidence
 * @property {MemoryStatus} status
 * @property {MemorySource} [source]
 * @property {MemoryProvenance} [provenance]
 * @property {MemorySalience} [salience]
 * @property {RetentionClass} [retentionClass]
 */

const nonEmpty = value => typeof value === 'string' && !!value.trim();
const isoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validSource(source) {
  return object(source) &&
    ['sessionId', 'messageId', 'speaker', 'device'].every(key => source[key] === undefined || nonEmpty(source[key])) &&
    (source.channel === undefined || ConversationChannels.includes(source.channel)) &&
    (source.observedAt === undefined || isoTime(source.observedAt)) &&
    (source.evidenceText === undefined || typeof source.evidenceText === 'string');
}

/**
 * 生成规范化的记忆唯一 ID
 * @param {string} kind
 * @returns {string}
 */
export function generateMemoryId(kind = 'mem') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${kind}_${ts}_${rand}`;
}

/**
 * 校验 MemoryEntry 格式
 * @param {any} entry
 * @returns {boolean}
 */
export function validateMemoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (!entry.id || typeof entry.id !== 'string') return false;
  if (!MemoryKinds.includes(entry.kind)) return false;
  if (!MemoryScopes.includes(entry.scope)) return false;
  if (!entry.content || typeof entry.content !== 'string') return false;
  if (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) return false;
  if (!MemoryStatuses.includes(entry.status)) return false;
  if (entry.importance !== undefined && !unit(entry.importance)) return false;
  if (entry.retentionClass !== undefined && !RetentionClasses.includes(entry.retentionClass)) return false;
  if (entry.salience !== undefined) {
    const salience = entry.salience;
    if (!object(salience) || (salience.importance !== null && !unit(salience.importance)) ||
        (salience.reason !== undefined && !nonEmpty(salience.reason)) ||
        (salience.policyVersion !== undefined && !nonEmpty(salience.policyVersion))) return false;
  }
  if (entry.provenance !== undefined) {
    const provenance = entry.provenance;
    if (!object(provenance)) return false;
    if (provenance.claimType === undefined) {
      return MemoryOrigins.includes(provenance.origin) && nonEmpty(provenance.speaker) &&
        ConversationChannels.includes(provenance.channel) && isoTime(provenance.timestamp);
    }
    if (!ProvenanceOrigins.includes(provenance.origin) || !ClaimTypes.includes(provenance.claimType) ||
        (provenance.evidenceStatus !== undefined && !EvidenceStatuses.includes(provenance.evidenceStatus)) ||
        (entry.source !== undefined && !validSource(entry.source))) return false;
    if (provenance.evidenceStatus === 'resolved') {
      const source = entry.source;
      if (!source || !nonEmpty(source.sessionId) || !nonEmpty(source.messageId) || !nonEmpty(source.speaker) ||
          !ConversationChannels.includes(source.channel) || !isoTime(source.observedAt) || !nonEmpty(source.evidenceText)) return false;
    }
  }
  return true;
}
