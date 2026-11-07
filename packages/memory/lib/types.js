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

export const MemoryOrigins = ['user_statement', 'shared_experience', 'model_inference'];

export function supersedeMemory(previous, replacementId, endedAt) {
  return { ...previous, status: 'superseded', supersededBy: replacementId, updatedAt: endedAt, validTo: endedAt };
}

/**
 * @typedef {Object} MemoryProvenance
 * @property {'user_statement'|'shared_experience'|'model_inference'} origin
 * @property {string} speaker
 * @property {'direct'|'group'} channel
 * @property {string} timestamp ISO timestamp
 */

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
  if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) return false;
  if (!MemoryStatuses.includes(entry.status)) return false;
  if (entry.importance !== undefined &&
      !(Number.isFinite(entry.importance) && entry.importance >= 0 && entry.importance <= 1)) return false;
  if (entry.provenance !== undefined) {
    const source = entry.provenance;
    if (!source || !MemoryOrigins.includes(source.origin) ||
        typeof source.speaker !== 'string' || !source.speaker.trim() ||
        !['direct', 'group'].includes(source.channel) ||
        typeof source.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(source.timestamp) ||
        !Number.isFinite(Date.parse(source.timestamp))) return false;
  }
  return true;
}
