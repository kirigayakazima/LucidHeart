// dsh-heart 的 Dream（经验沉淀与成长闭环层）实现。
//
// 核心原则（Step 3B & 3C 规范）：
// 1. 手动调用 heart_dream，零后台定时器，不增加自动触发；
// 2. 只读取当前会话内存切片，不读取历史会话压缩包；
// 3. 严格限制输入与输出长度（最多 3 条候选）；
// 4. 候选经验在 <root>/dream/insights.json 独立保存，未确认前绝不自动修改长期记忆；
// 5. 采用完整 SHA-256 内容哈希作为 ID，相同内容去重不重复保存；
// 6. 锁内重新读取最新数据，整文件原子写回，损坏文件写保护绝不覆写；
// 7. 经验晋升（Promote）受控两阶段执行（预览 preview / 提交 commit），根据分类严格映射目标记忆；
// 8. 晋升操作具备跨故障重试内容幂等保护，杜绝重复向长期记忆追加条目。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  resolveRoot,
  acquireDirLock,
  releaseDirLock,
  isDirLockHeld,
  safeAtomicReplace,
  appendFact,
  appendNotebook,
  appendVoiceLearned,
  readFacts,
  readNotebook,
  readMemoryMode,
  EXTERNAL_MEMORY_MESSAGE,
} from './store.js'
import { log } from './logger.js'

export const DREAM_DIR = 'dream'
export const INSIGHTS_FILE = 'insights.json'
export const INSIGHTS_LOCK = 'insights.lock'

export const INSIGHT_CATEGORIES = Object.freeze([
  'communication',
  'workflow',
  'environment',
  'general',
])

export const INSIGHT_TYPES = Object.freeze([
  'fact',
  'observation',
  'inference',
  'hypothesis',
])

export const INSIGHT_STATUSES = Object.freeze([
  'candidate',
  'confirmed',
  'rejected',
  'promoted',
])

/**
 * 规范化经验正文：去除多余空白字符
 */
export function normalizeStatement(statement) {
  if (typeof statement !== 'string') return ''
  return statement.trim().replace(/\s+/g, ' ')
}

/**
 * 生成经验的完整 SHA-256 确定性内容 ID
 */
export function generateInsightId(category, statement) {
  const normCategory = String(category || '').trim().toLowerCase()
  const normStatement = normalizeStatement(statement)
  return crypto
    .createHash('sha256')
    .update(`${normCategory}:${normStatement}`, 'utf8')
    .digest('hex')
}

/**
 * 校验候选经验的 Schema 合法性
 */
export function validateCandidateInsight(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'invalid-object', message: '候选经验必须是非空对象' }
  }

  const category = String(candidate.category || '').trim().toLowerCase()
  if (!INSIGHT_CATEGORIES.includes(category)) {
    return {
      ok: false,
      reason: 'invalid-category',
      message: `非法分类 "${candidate.category}"，必须是 ${INSIGHT_CATEGORIES.join(', ')} 之一`,
    }
  }

  const type = String(candidate.type || '').trim().toLowerCase()
  if (!INSIGHT_TYPES.includes(type)) {
    return {
      ok: false,
      reason: 'invalid-type',
      message: `非法认识论类型 "${candidate.type}"，必须是 ${INSIGHT_TYPES.join(', ')} 之一`,
    }
  }

  const normStatement = normalizeStatement(candidate.statement)
  if (!normStatement) {
    return { ok: false, reason: 'empty-statement', message: '经验陈述正文不能为空' }
  }
  if (normStatement.length > 200) {
    return {
      ok: false,
      reason: 'statement-too-long',
      message: `经验陈述正文超过 200 字限制（当前 ${normStatement.length} 字）`,
    }
  }

  let confidence = candidate.confidence
  if (confidence === undefined || confidence === null) {
    confidence = 0.8
  } else {
    confidence = Number(confidence)
    if (isNaN(confidence) || !isFinite(confidence) || confidence < 0.0 || confidence > 1.0) {
      return {
        ok: false,
        reason: 'invalid-confidence',
        message: '置信度必须是 0.0 到 1.0 之间的数值',
      }
    }
  }

  return {
    ok: true,
    normalized: {
      category,
      type,
      statement: normStatement,
      confidence: Math.round(confidence * 100) / 100,
    },
  }
}

/**
 * 提取并清洗当前会话的最近消息切片。
 */
export function filterSessionMessages(messages, options = {}) {
  const maxTurns = Number(options.maxTurns) || 12
  const maxChars = Number(options.maxChars) || 4000

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      turns: 0,
      totalChars: 0,
      messages: [],
      formattedText: '',
    }
  }

  const rawValid = []
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const role = m.role
    if (role !== 'user' && role !== 'assistant') continue

    // 剔除系统内部注入消息
    if (m.source && typeof m.source.kind === 'string') {
      const kind = m.source.kind.toLowerCase()
      if (kind.includes('system') || kind.includes('inject') || kind.includes('context')) {
        continue
      }
    }

    let text = ''
    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((part) => {
          if (typeof part === 'string') return part
          if (part && typeof part.text === 'string') return part.text
          return ''
        })
        .join(' ')
    }

    text = text.trim()
    if (!text) continue

    // 工具输出与长消息截断
    const limit = role === 'user' ? 500 : 800
    if (text.length > limit) {
      text = text.slice(0, limit) + ' ...[截断]'
    }

    rawValid.push({
      role,
      content: text,
      timestamp: m.timestamp || m.createdAt || null,
    })
  }

  const slice = rawValid.slice(-maxTurns * 2)

  let charCount = 0
  const kept = []
  for (let i = slice.length - 1; i >= 0; i--) {
    const item = slice[i]
    if (charCount + item.content.length > maxChars && kept.length > 0) {
      break
    }
    charCount += item.content.length
    kept.unshift(item)
  }

  const formattedLines = kept.map((m) => {
    const label = m.role === 'user' ? '用户' : '助手'
    return `[${label}]: ${m.content}`
  })

  const turnCount = kept.filter((m) => m.role === 'user').length

  return {
    turns: turnCount,
    totalChars: charCount,
    messages: kept,
    formattedText: formattedLines.join('\n\n'),
  }
}

/**
 * 解析并校验模型输出的候选经验。
 */
export function parseModelInsights(rawInput) {
  if (!rawInput) {
    return { ok: false, reason: 'empty-input', message: '输入内容为空' }
  }

  let candidates = rawInput
  if (typeof rawInput === 'string') {
    let clean = rawInput.trim()
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    }
    try {
      candidates = JSON.parse(clean)
    } catch {
      return {
        ok: false,
        reason: 'invalid-json',
        message: '模型输出不是合法的 JSON 格式，无法解析为候选经验',
      }
    }
  }

  if (!Array.isArray(candidates)) {
    return {
      ok: false,
      reason: 'not-an-array',
      message: '候选经验必须是 JSON 数组结构',
    }
  }

  if (candidates.length === 0) {
    return { ok: true, insights: [] }
  }

  const limited = candidates.slice(0, 3)
  const validated = []

  for (let i = 0; i < limited.length; i++) {
    const check = validateCandidateInsight(limited[i])
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        message: `第 ${i + 1} 条经验校验失败: ${check.message}`,
      }
    }
    validated.push(check.normalized)
  }

  return { ok: true, insights: validated }
}

/**
 * 校验已持久化的 Insight 对象完整性
 */
export function isValidPersistedInsight(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (typeof obj.id !== 'string' || obj.id.length !== 64) return false
  if (!INSIGHT_CATEGORIES.includes(obj.category)) return false
  if (!INSIGHT_TYPES.includes(obj.type)) return false
  if (!INSIGHT_STATUSES.includes(obj.status)) return false
  if (typeof obj.statement !== 'string' || !obj.statement.trim()) return false
  if (typeof obj.createdAt !== 'string' || typeof obj.updatedAt !== 'string') return false
  return true
}

/**
 * 读取本地 insights.json 数据。
 */
export function readInsights(root) {
  const dir = resolveRoot(root)
  const file = path.join(dir, DREAM_DIR, INSIGHTS_FILE)

  if (!fs.existsSync(file)) {
    return { ok: true, corrupted: false, items: [] }
  }

  try {
    const content = fs.readFileSync(file, 'utf8')
    if (!content.trim()) {
      return { ok: true, corrupted: false, items: [] }
    }
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) {
      log.store(root, 'warn', 'corrupt_insights_format', { error: 'not-an-array' })
      return { ok: false, corrupted: true, items: [] }
    }
    const valid = []
    for (const item of parsed) {
      if (!isValidPersistedInsight(item)) {
        log.store(root, 'warn', 'corrupt_insight_item', { item })
        return { ok: false, corrupted: true, items: [] }
      }
      valid.push(item)
    }
    return { ok: true, corrupted: false, items: valid }
  } catch (err) {
    log.store(root, 'warn', 'corrupt_insights_read_error', { error: err.message })
    return { ok: false, corrupted: true, items: [] }
  }
}

/**
 * 校验并持久化保存候选经验到 <root>/dream/insights.json。
 */
export function saveInsights(root, candidates, sessionInfo = {}, now = new Date()) {
  const dir = resolveRoot(root)
  const dreamDir = path.join(dir, DREAM_DIR)
  const file = path.join(dreamDir, INSIGHTS_FILE)
  const lockDir = path.join(dreamDir, INSIGHTS_LOCK)

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: true, saved: [], skipped: [], message: '没有需要保存的候选经验' }
  }

  const nowIso = (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString()

  if (!fs.existsSync(dreamDir)) {
    fs.mkdirSync(dreamDir, { recursive: true })
  }

  const lockToken = acquireDirLock(lockDir, { staleMs: 15000 })
  if (!lockToken) {
    log.store(root, 'warn', 'lock_timeout', { lock: INSIGHTS_LOCK, action: 'saveInsights' }, now)
    return {
      ok: false,
      reason: 'lock-timeout',
      message: '获取 Dream 文件锁超时，可能有其他并发写入操作',
    }
  }

  let tmpFile = null
  try {
    const current = readInsights(root)
    if (current.corrupted) {
      log.store(root, 'error', 'write_protection_triggered', { file: INSIGHTS_FILE }, now)
      return {
        ok: false,
        reason: 'corrupted-data',
        message: '检测到 insights.json 数据损坏，已触发写保护以保留磁盘现场，拒绝覆写',
      }
    }

    const itemsMap = new Map()
    for (const item of current.items) {
      itemsMap.set(item.id, item)
    }

    const saved = []
    const skipped = []

    for (const c of candidates) {
      const id = generateInsightId(c.category, c.statement)
      if (itemsMap.has(id)) {
        skipped.push({ id, statement: c.statement, reason: 'duplicate' })
        continue
      }

      const record = {
        id,
        category: c.category,
        statement: c.statement,
        type: c.type,
        status: 'candidate',
        confidence: c.confidence !== undefined ? c.confidence : 0.8,
        source: {
          session: sessionInfo.session || '',
          turnCount: Number(sessionInfo.turnCount) || 0,
          timestamp: nowIso,
        },
        createdAt: nowIso,
        updatedAt: nowIso,
      }

      itemsMap.set(id, record)
      saved.push(record)
    }

    if (saved.length === 0) {
      log.dream(root, 'info', 'save_insights_all_duplicates', { skippedCount: skipped.length }, now)
      return {
        ok: true,
        saved: [],
        skipped,
        message: '所有候选经验均已存在，无需重复保存',
      }
    }

    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(dreamDir, `${INSIGHTS_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    const fullList = Array.from(itemsMap.values())
    fs.writeFileSync(tmpFile, JSON.stringify(fullList, null, 2) + '\n', 'utf8')

    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被接管或失效')
    }

    safeAtomicReplace(tmpFile, file)
    log.dream(root, 'info', 'save_insights_success', {
      savedCount: saved.length,
      skippedCount: skipped.length,
      totalCount: fullList.length,
    }, now)

    return {
      ok: true,
      saved,
      skipped,
      totalCount: fullList.length,
      message: `成功保存 ${saved.length} 条候选经验${skipped.length > 0 ? `（${skipped.length} 条已存在跳过）` : ''}`,
    }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    log.dream(root, 'error', 'save_insights_error', { error: err.message }, now)
    throw err
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}

/**
 * 审核状态流转纯函数：根据当前状态与动作执行流转判定
 */
export function applyInsightTransition(current, action, options = {}, now = new Date()) {
  if (!current || !current.status) {
    return { ok: false, reason: 'not-found', message: '条目不存在' }
  }

  const curStatus = current.status
  const nowIso = (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString()

  if (action === 'confirm') {
    if (curStatus === 'confirmed') {
      return { ok: true, changed: false, insight: current, message: '该条目已经是确认状态' }
    }
    if (curStatus === 'promoted') {
      return {
        ok: false,
        reason: 'illegal-transition',
        message: '已晋升至长期记忆的条目不可重新审核确认',
      }
    }
    if (curStatus === 'rejected') {
      return {
        ok: false,
        reason: 'illegal-transition',
        message: '已驳回的条目不能直接确认',
      }
    }
    // candidate -> confirmed
    return {
      ok: true,
      changed: true,
      insight: {
        ...current,
        status: 'confirmed',
        updatedAt: nowIso,
      },
      message: '经验已成功确认为有效条目',
    }
  }

  if (action === 'reject') {
    if (curStatus === 'rejected') {
      return { ok: true, changed: false, insight: current, message: '该条目已经是驳回状态' }
    }
    if (curStatus === 'promoted') {
      return {
        ok: false,
        reason: 'illegal-transition',
        message: '已晋升至长期记忆的条目不可驳回',
      }
    }
    if (curStatus === 'confirmed') {
      return {
        ok: false,
        reason: 'illegal-transition',
        message: '已确认的条目不能直接驳回',
      }
    }
    // candidate -> rejected
    return {
      ok: true,
      changed: true,
      insight: {
        ...current,
        status: 'rejected',
        statusReason: options.reason ? String(options.reason).trim() : '',
        updatedAt: nowIso,
      },
      message: '经验已标记驳回',
    }
  }

  if (action === 'promote') {
    if (curStatus === 'promoted') {
      return { ok: true, changed: false, insight: current, message: '该条目此前已晋升为长期记忆' }
    }
    if (curStatus === 'candidate') {
      return {
        ok: false,
        reason: 'unconfirmed-not-promotable',
        message: '未确认的候选经验不能晋升为长期记忆，请先人工 confirm',
      }
    }
    if (curStatus === 'rejected') {
      return {
        ok: false,
        reason: 'rejected-not-promotable',
        message: '已驳回的经验不能晋升为长期记忆',
      }
    }
    // confirmed -> promoted
    return {
      ok: true,
      changed: true,
      insight: {
        ...current,
        status: 'promoted',
        promotedAt: nowIso,
        promotedTo: options.targetFile || '',
        updatedAt: nowIso,
      },
      message: '经验已成功晋升为长期记忆',
    }
  }

  return {
    ok: false,
    reason: 'invalid-action',
    message: `不支持的审核操作 "${action}"（支持 confirm / reject / promote）`,
  }
}

/**
 * 更新单条经验的审核状态并持久化。
 */
export function updateInsightStatus(root, id, action, options = {}, now = new Date()) {
  if (!id || typeof id !== 'string') {
    return { ok: false, reason: 'invalid-id', message: '必须提供经验条目 ID' }
  }

  const dir = resolveRoot(root)
  const dreamDir = path.join(dir, DREAM_DIR)
  const file = path.join(dreamDir, INSIGHTS_FILE)
  const lockDir = path.join(dreamDir, INSIGHTS_LOCK)

  const lockToken = acquireDirLock(lockDir, { staleMs: 15000 })
  if (!lockToken) {
    log.store(root, 'warn', 'lock_timeout', { lock: INSIGHTS_LOCK, action: `update_${action}` }, now)
    return {
      ok: false,
      reason: 'lock-timeout',
      message: '获取 Dream 文件锁超时，请稍后重试',
    }
  }

  let tmpFile = null
  try {
    const currentData = readInsights(root)
    if (currentData.corrupted) {
      log.store(root, 'error', 'write_protection_triggered', { file: INSIGHTS_FILE }, now)
      return {
        ok: false,
        reason: 'corrupted-data',
        message: '检测到 insights.json 损坏，已触发写保护拒绝覆盖',
      }
    }

    const items = currentData.items
    const targetId = id.trim()
    const matchIndex = items.findIndex((it) => it.id === targetId || (targetId.length >= 8 && it.id.startsWith(targetId)))

    if (matchIndex === -1) {
      return {
        ok: false,
        reason: 'not-found',
        message: `未找到匹配 ID "${targetId}" 的经验条目`,
      }
    }

    const targetItem = items[matchIndex]
    const transition = applyInsightTransition(targetItem, action, options, now)
    if (!transition.ok) {
      log.dream(root, 'debug', `transition_${action}_failed`, { id: targetItem.id, reason: transition.reason }, now)
      return transition
    }

    if (!transition.changed) {
      return transition
    }

    items[matchIndex] = transition.insight

    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(dreamDir, `${INSIGHTS_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    fs.writeFileSync(tmpFile, JSON.stringify(items, null, 2) + '\n', 'utf8')

    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被接管或失效')
    }

    safeAtomicReplace(tmpFile, file)
    log.dream(root, 'info', `insight_${action}_success`, {
      id: transition.insight.id,
      status: transition.insight.status,
      reason: options.reason || undefined,
    }, now)

    return {
      ok: true,
      changed: true,
      insight: transition.insight,
      message: transition.message,
    }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    log.dream(root, 'error', `insight_${action}_error`, { error: err.message }, now)
    throw err
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}

/**
 * 根据经验类型与业务分类，解析晋升目标记忆文件
 */
export function resolvePromotionTarget(insight, { memoryMode = 'legacy', selfPrinciple = false } = {}) {
  if (!insight || typeof insight !== 'object') {
    return { ok: false, reason: 'invalid-insight', message: '经验对象不能为空' }
  }

  const category = String(insight.category || '').toLowerCase()
  const type = String(insight.type || '').toLowerCase()
  if (memoryMode === 'external' && type === 'fact') {
    return { ok: false, reason: 'external-memory-read-only', message: EXTERNAL_MEMORY_MESSAGE }
  }

  // 假设型认知不能直接晋升为长期记忆
  if (type === 'hypothesis') {
    return {
      ok: false,
      reason: 'unverified-hypothesis',
      message: '假设型认知（hypothesis）未经充分验证，不能直接晋升为长期记忆',
    }
  }

  // 1. 表达/沟通偏好 -> body/voice-learned.md
  if (category === 'communication') {
    return {
      ok: true,
      target: 'voice',
      file: 'body/voice-learned.md',
      desc: '表达与沟通习惯（voice-learned.md）',
    }
  }

  if (memoryMode === 'external' && !selfPrinciple) {
    return { ok: false, reason: 'self-principle-required', message: 'external 模式只允许 Notebook 自我原则。人工确认其属于自我原则后，需显式传 selfPrinciple=true；用户事实/历史应由 Mnemon 保存。' }
  }

  // 2. 稳定事实 -> facts.md
  if (type === 'fact') {
    return {
      ok: true,
      target: 'facts',
      file: 'facts.md',
      desc: '事实记忆（facts.md）',
    }
  }

  // 3. 工作流与行为原则 -> notebook.md
  if (category === 'workflow' || category === 'environment' || type === 'observation' || type === 'inference') {
    return {
      ok: true,
      target: 'notebook',
      file: 'notebook.md',
      desc: '本子工作原则/操作准则（notebook.md）',
    }
  }

  // 默认归入 notebook
  return {
    ok: true,
    target: 'notebook',
    file: 'notebook.md',
    desc: '本子工作原则/操作准则（notebook.md）',
  }
}

/**
 * 人工确认后的经验晋升（分两阶段：preview 预览 / commit 提交）
 *
 * 契约规范：
 * - 默认 commit: false 为预览模式：展示目标文件与执行动作，不改动任何文件；
 * - 显式 commit: true 为提交模式：严格校验状态为 confirmed 后写入长期记忆并持久化状态；
 * - 幂等保障：若目标记忆文件已存在对应陈述，不重复追加；已处于 promoted 状态时安全幂等成功；
 * - 故障恢复：即使写盘中途重试，绝不重复生成多条记忆记录。
 */
export function promoteInsight(root, id, options = {}, now = new Date()) {
  if (!id || typeof id !== 'string') {
    return { ok: false, reason: 'invalid-id', message: '必须提供要晋升的经验 ID' }
  }

  const isCommit = Boolean(options && options.commit)
  const dir = resolveRoot(root)
  const dreamDir = path.join(dir, DREAM_DIR)
  const file = path.join(dreamDir, INSIGHTS_FILE)
  const lockDir = path.join(dreamDir, INSIGHTS_LOCK)
  const targetId = id.trim()

  // 1. 读取当前经验数据
  const currentData = readInsights(root)
  if (currentData.corrupted) {
    log.dream(root, 'error', 'promote_preview', { id: targetId, error: 'corrupted-data' }, now)
    return {
      ok: false,
      reason: 'corrupted-data',
      message: '检测到 insights.json 损坏，已触发只读写保护拒绝操作',
    }
  }

  const items = currentData.items
  const matchIndex = items.findIndex((it) => it.id === targetId || (targetId.length >= 8 && it.id.startsWith(targetId)))
  if (matchIndex === -1) {
    return {
      ok: false,
      reason: 'not-found',
      message: `未找到匹配 ID "${targetId}" 的经验条目`,
    }
  }

  const targetItem = items[matchIndex]

  // 2. 校验晋升资格
  if (targetItem.status === 'rejected') {
    log.dream(root, 'warn', 'promote_rejected', { id: targetItem.id, result: 'rejected' }, now)
    return {
      ok: false,
      reason: 'rejected-not-promotable',
      message: '已驳回的经验不能晋升为长期记忆',
    }
  }

  if (targetItem.status === 'candidate') {
    log.dream(root, 'warn', 'promote_unconfirmed', { id: targetItem.id, result: 'unconfirmed' }, now)
    return {
      ok: false,
      reason: 'unconfirmed-not-promotable',
      message: '未确认的候选经验不能晋升为长期记忆，必须由人工先 confirm 确认',
    }
  }

  // 3. 确定归宿目标文件
  const targetResolution = resolvePromotionTarget(targetItem, { memoryMode: readMemoryMode(root), selfPrinciple: options.selfPrinciple === true })
  if (!targetResolution.ok) {
    log.dream(root, 'warn', 'promote_target_error', { id: targetItem.id, error: targetResolution.message }, now)
    return targetResolution
  }

  // 4. 若为 preview 预览模式，只读回显，不写入任何数据
  if (!isCommit) {
    log.dream(root, 'info', 'promote_preview', { id: targetItem.id, target: targetResolution.target }, now)
    const previewMsg = [
      `【经验晋升预览】`,
      `- 经验 ID: [${targetItem.id.slice(0, 8)}]`,
      `- 经验陈述: ${targetItem.statement}`,
      `- 认识类型: ${targetItem.type} / 业务分类: ${targetItem.category}`,
      `- 当前状态: ${targetItem.status}`,
      `- 晋升目标: ${targetResolution.desc}`,
      `- 目标文件: ${targetResolution.file}`,
      `- 状态流转: ${targetItem.status} -> promoted`,
      `- 提示说明: 当前为只读预览，尚未写入长期记忆。若确认晋升，请调用 heart_dream(action="promote", id="${targetItem.id.slice(0, 8)}", commit=true${readMemoryMode(root) === 'external' && targetResolution.target === 'notebook' ? ', selfPrinciple=true' : ''}) 执行写入。`,
    ].join('\n')

    return {
      ok: true,
      isPreview: true,
      insight: targetItem,
      target: targetResolution.target,
      targetFile: targetResolution.file,
      targetDesc: targetResolution.desc,
      message: previewMsg,
    }
  }

  // 5. 提交模式：获取互斥锁并在锁内执行
  const lockToken = acquireDirLock(lockDir, { staleMs: 15000 })
  if (!lockToken) {
    log.store(root, 'warn', 'lock_timeout', { lock: INSIGHTS_LOCK, action: 'promote' }, now)
    return {
      ok: false,
      reason: 'lock-timeout',
      message: '获取 Dream 文件锁超时，请稍后重试',
    }
  }

  let tmpFile = null
  try {
    const freshData = readInsights(root)
    if (freshData.corrupted) {
      return {
        ok: false,
        reason: 'corrupted-data',
        message: '检测到 insights.json 损坏，已触发写保护拒绝覆写',
      }
    }

    const freshItems = freshData.items
    const freshIndex = freshItems.findIndex((it) => it.id === targetId || (targetId.length >= 8 && it.id.startsWith(targetId)))
    if (freshIndex === -1) {
      return { ok: false, reason: 'not-found', message: `锁内未找到匹配 ID "${targetId}" 的经验条目` }
    }

    const itemToPromote = freshItems[freshIndex]
    const freshTarget = resolvePromotionTarget(itemToPromote, { memoryMode: readMemoryMode(root), selfPrinciple: options.selfPrinciple === true })
    if (!freshTarget.ok) return freshTarget

    // 幂等防重：如果已经是 promoted 状态
    if (itemToPromote.status === 'promoted') {
      log.dream(root, 'info', 'promote_idempotent', { id: itemToPromote.id, result: 'already_promoted' }, now)
      return {
        ok: true,
        alreadyPromoted: true,
        insight: itemToPromote,
        message: `该经验此前已成功晋升写入 ${itemToPromote.promotedTo || targetResolution.desc}，无需重复执行。`,
      }
    }

    if (itemToPromote.status !== 'confirmed') {
      return {
        ok: false,
        reason: 'invalid-status',
        message: `经验当前状态为 "${itemToPromote.status}"，只有已确认（confirmed）的经验允许晋升`,
      }
    }

    // 6. 执行长期记忆写入（具备跨重试内容幂等防重）
    const nowIso = (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString()
    const stmt = itemToPromote.statement

    if (targetResolution.target === 'voice') {
      const appendRes = appendVoiceLearned(root, stmt, now)
      if (!appendRes.ok && appendRes.reason !== 'duplicate') {
        throw new Error(`写入表达习惯文件失败: ${appendRes.message || appendRes.reason}`)
      }
      log.memory(root, 'info', 'append_voice_learned', {
        id: itemToPromote.id,
        statement: stmt,
        skipped: Boolean(appendRes.skipped),
      }, now)
    } else if (targetResolution.target === 'facts') {
      const existingFacts = readFacts(root)
      const alreadyHas = typeof existingFacts === 'string' ? existingFacts.includes(stmt) : false
      if (!alreadyHas) {
        appendFact(root, stmt, now)
        log.memory(root, 'info', 'append_fact', { id: itemToPromote.id, statement: stmt }, now)
      } else {
        log.memory(root, 'info', 'append_fact_skipped_duplicate', { id: itemToPromote.id, statement: stmt }, now)
      }
    } else {
      // target === 'notebook'
      const existingNotes = readNotebook(root)
      const alreadyHas = typeof existingNotes === 'string' ? existingNotes.includes(stmt) : false
      if (!alreadyHas) {
        appendNotebook(root, stmt, now)
        log.memory(root, 'info', 'append_notebook', { id: itemToPromote.id, statement: stmt }, now)
      } else {
        log.memory(root, 'info', 'append_notebook_skipped_duplicate', { id: itemToPromote.id, statement: stmt }, now)
      }
    }

    // 7. 更新经验状态并写回 insights.json
    itemToPromote.status = 'promoted'
    itemToPromote.promotedAt = nowIso
    itemToPromote.promotedTo = targetResolution.file
    itemToPromote.updatedAt = nowIso

    freshItems[freshIndex] = itemToPromote

    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(dreamDir, `${INSIGHTS_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    fs.writeFileSync(tmpFile, JSON.stringify(freshItems, null, 2) + '\n', 'utf8')

    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被接管或失效')
    }

    safeAtomicReplace(tmpFile, file)
    log.dream(root, 'info', 'promote_commit_success', {
      id: itemToPromote.id,
      target: targetResolution.target,
      file: targetResolution.file,
    }, now)

    return {
      ok: true,
      committed: true,
      insight: itemToPromote,
      target: targetResolution.target,
      targetFile: targetResolution.file,
      message: `已成功将经验 [${itemToPromote.id.slice(0, 8)}] 晋升并写入 ${targetResolution.desc}！`,
    }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    log.dream(root, 'error', 'promote_error', { id: targetId, error: err.message || String(err) }, now)
    throw err
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}
