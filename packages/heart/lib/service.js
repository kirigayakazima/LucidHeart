// Heart 0.20.0 Service 实现 (Microkernel)
// 提供 Cordis 服务接口与事件分发，实现感知接入、状态快照与活动评估。

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  HEART_PROTOCOL_VERSION,
  HEART_CORE_VERSION,
  HEART_EVENTS,
  ERROR_CODES,
  validateObservation,
  validateActivityIntent,
} from '../contracts/index.js'
import {
  readMood,
  updateMood,
  resetMood,
} from './mood.js'
import {
  readSense,
  appendSenseLog,
} from './sense.js'
import {
  readTrigger,
  idleCategoryState,
  idleCategoryRemaining,
} from './trigger.js'
import {
  readHeartConfig,
  readMemoryMode,
  dateOf,
  inQuietHours,
  readSpeak,
  resolveRoot,
} from './store.js'
import { log } from './logger.js'

export class HeartService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {string} root
   * @param {Record<string, any>} config
   */
  constructor(ctx, root, config = {}) {
    this.ctx = ctx
    this.root = root
    this.config = config
    this.protocolVersion = HEART_PROTOCOL_VERSION
    this.version = HEART_CORE_VERSION
    this.name = 'heart'
    this._lastSnapshot = null
  }

  /**
   * 1. heart.getSnapshot()
   * 只读获取内部状态外部视图
   */
  getSnapshot() {
    const root = this.root
    const mood = readMood(root)
    const sense = readSense(root)
    const trigger = readTrigger(root)
    const diskFile = path.join(resolveRoot(root), 'config.json')
    let diskCustom = {}
    try {
      if (fs.existsSync(diskFile)) diskCustom = JSON.parse(fs.readFileSync(diskFile, 'utf8'))
    } catch {}
    const liveConfig = { ...readHeartConfig(root), ...this.config, ...diskCustom }
    const memoryMode = readMemoryMode(root)
    const today = dateOf()

    const { counts } = idleCategoryState(trigger, new Date())
    const categories = idleCategoryRemaining(liveConfig, counts)
    const totalCap = Number(liveConfig.idleTurnDailyCap) || 6
    const totalUsed = trigger.idleDate === today ? Number(trigger.idleCount) || 0 : 0

    const snapshot = Object.freeze({
      protocolVersion: this.protocolVersion,
      heartVersion: this.version,
      timestamp: new Date().toISOString(),
      device: String(liveConfig.device || 'phone'),
      memoryMode,
      mood: Object.freeze({
        state: mood.state || 'calm',
        intensity: mood.intensity || 0.0,
        reason: mood.reason || 'baseline',
        valence: mood.valence !== undefined ? mood.valence : 0.2,
        arousal: mood.arousal !== undefined ? mood.arousal : 0.3,
        energy: mood.energy !== undefined ? mood.energy : 0.6,
        why: mood.why || '日常基准状态',
        updatedAt: mood.updatedAt || new Date().toISOString(),
      }),
      presence: Object.freeze({
        status: sense?.presence || 'unknown',
        lastSeenAt: sense?.at || undefined,
      }),
      idle: Object.freeze({
        date: today,
        totalUsed,
        totalCap,
        nextIdleAt: trigger.nextIdleAt || null,
        categories: Object.freeze(categories.map((c) => Object.freeze({ ...c }))),
      }),
    })

    this._lastSnapshot = snapshot
    return snapshot
  }

  /**
   * 2. heart.observe(input)
   * 接收外部感知，验证来源并根据内部规则决定是否改变状态。严禁调用方直写 Mood。
   */
  async observe(input) {
    const validated = validateObservation(input)
    if (!validated.valid) {
      log.core(this.root, 'warn', 'invalid_observation', { error: validated.error, input })
      return {
        accepted: false,
        code: validated.code,
        reason: validated.error,
        stateChanged: false,
      }
    }

    const { type, source, timestamp, confidence, evidence, summary } = validated.data
    const observationId = randomUUID()
    const prevSnapshot = this.getSnapshot()

    // 记录原始事实感知日志
    try {
      log.core(this.root, 'info', 'observation_received', {
        id: observationId,
        detail: {
          type,
          source,
          confidence,
          summary,
          evidence,
        },
      })
      if (type === 'sensor' && evidence) {
        appendSenseLog(this.root, {
          at: timestamp,
          presence: evidence.online === false ? 'away' : 'present',
          fg: evidence.foregroundWindow,
        }, this.config)
      }
    } catch {
      // 感知日志记录失败不阻断核心评估
    }

    // 根据 Heart 自有策略决定状态更新，拒绝外部直写数值
    let stateChanged = false
    let actionTaken = 'recorded_observation'

    // 状态映射策略：依据感知事实与置信度，决定是否触发 mood 状态转移
    const moodCandidate = this._mapObservationToMood(type, source, confidence, evidence, summary)
    if (moodCandidate) {
      const updateResult = updateMood(this.root, moodCandidate)
      if (updateResult.ok) {
        stateChanged = true
        actionTaken = `mood_updated_${updateResult.mood.state}`
        log.mood(this.root, 'info', 'mood_updated_from_observation', {
          observationId,
          type,
          source,
          newState: updateResult.mood.state,
          intensity: updateResult.mood.intensity,
        })
      }
    }

    const currentSnapshot = this.getSnapshot()

    // 状态变化时触发事件通知
    if (stateChanged) {
      this.notifyStateChanged(prevSnapshot, currentSnapshot, `observation:${type}`)
    }

    return {
      accepted: true,
      observationId,
      stateChanged,
      actionTaken,
      snapshot: currentSnapshot,
    }
  }

  /**
   * 3. heart.evaluateActivity(intent)
   * 评估某项外部自主活动是否符合当前心境与配额，返回建议（不等于执行授权）
   */
  evaluateActivity(intentInput) {
    const validated = validateActivityIntent(intentInput)
    if (!validated.valid) {
      return {
        suitable: false,
        code: validated.code,
        reason: validated.error,
        currentMood: 'unknown',
        recommendation: '请求参数不合法，拒绝建议',
      }
    }

    const { intent, category } = validated.data
    const root = this.root
    const mood = readMood(root)
    const trigger = readTrigger(root)
    const diskFile = path.join(resolveRoot(root), 'config.json')
    let diskCustom = {}
    try {
      if (fs.existsSync(diskFile)) diskCustom = JSON.parse(fs.readFileSync(diskFile, 'utf8'))
    } catch {}
    const liveConfig = { ...readHeartConfig(root), ...this.config, ...diskCustom }
    const speakState = readSpeak(root)
    const now = new Date()

    // 1. 安静时段检查
    const quietFrom = liveConfig.quietFrom || speakState?.quietFrom || '23:00'
    const quietTo = liveConfig.quietTo || speakState?.quietTo || '08:00'
    if (inQuietHours(now, quietFrom, quietTo)) {
      return {
        suitable: false,
        reason: 'quiet-hours',
        currentMood: mood.state,
        recommendation: `当前处于安静时段（${quietFrom} - ${quietTo}），建议静默休息，不建议执行活动。`,
      }
    }

    // 2. 配额与类别检查
    const today = dateOf(now)
    const cap = Number(liveConfig.idleTurnDailyCap) || 6
    const used = trigger.idleDate === today ? Number(trigger.idleCount) || 0 : 0
    if (used >= cap) {
      return {
        suitable: false,
        reason: 'daily-cap',
        currentMood: mood.state,
        quota: { used, cap, remaining: 0 },
        recommendation: `今日空闲自主活动配额已达上限（${used}/${cap}），请休息。`,
      }
    }

    const { counts } = idleCategoryState(trigger, now)
    const remainingCategories = idleCategoryRemaining(liveConfig, counts)
    const targetCat = category ? remainingCategories.find((c) => c.id === category) : null

    if (category && targetCat && targetCat.remaining <= 0) {
      return {
        suitable: false,
        reason: 'category-cap',
        currentMood: mood.state,
        quota: { used: targetCat.used, cap: targetCat.dailyCap, remaining: 0 },
        recommendation: `类别 [${targetCat.label}] 今日配额已耗尽（${targetCat.used}/${targetCat.dailyCap}），建议切换类别或休息。`,
      }
    }

    // 3. 心境状态适宜性逻辑
    if (mood.state === 'tired') {
      if (category === 'study' || intent.includes('heavy') || intent.includes('audit')) {
        return {
          suitable: false,
          reason: 'mood-tired',
          currentMood: mood.state,
          recommendation: '当前处于疲劳舒缓状态 (tired)，不建议进行高强度或专注型活动，建议休息或轻度活动。',
        }
      }
    }

    return {
      suitable: true,
      reason: 'ok',
      currentMood: mood.state,
      quota: targetCat
        ? { used: targetCat.used, cap: targetCat.dailyCap, remaining: targetCat.remaining }
        : { used, cap, remaining: cap - used },
      recommendation: `当前状态 (${mood.state}) 适合进行该项活动 (${intent})。请各插件在完成时通过正规工具记账。`,
    }
  }

  /**
   * 4. 派发 heart/state-changed 事件通知
   * 异步派发，保证单个外部监听器抛错不会拖垮 Heart Core
   */
  notifyStateChanged(prev, current, eventSource = 'unknown') {
    if (!this.ctx) return
    const payload = Object.freeze({
      prev,
      current,
      eventSource,
      timestamp: new Date().toISOString(),
    })

    try {
      if (typeof this.ctx.parallel === 'function') {
        this.ctx.parallel(HEART_EVENTS.STATE_CHANGED, payload).catch((err) => {
          log.core(this.root, 'warn', 'listener_error_state_changed', { error: String(err && err.message || err) })
        })
      } else if (typeof this.ctx.emit === 'function') {
        this.ctx.emit(HEART_EVENTS.STATE_CHANGED, payload)
      }
    } catch (err) {
      log.core(this.root, 'warn', 'emit_state_changed_failed', { error: String(err && err.message || err) })
    }
  }

  /**
   * 5. 派发 heart/idle 事件通知
   */
  notifyIdle(payload) {
    if (!this.ctx) return
    const eventPayload = Object.freeze({
      ...payload,
      timestamp: new Date().toISOString(),
    })

    try {
      if (typeof this.ctx.parallel === 'function') {
        this.ctx.parallel(HEART_EVENTS.IDLE, eventPayload).catch((err) => {
          log.core(this.root, 'warn', 'listener_error_idle', { error: String(err && err.message || err) })
        })
      } else if (typeof this.ctx.emit === 'function') {
        this.ctx.emit(HEART_EVENTS.IDLE, eventPayload)
      }
    } catch (err) {
      log.core(this.root, 'warn', 'emit_idle_failed', { error: String(err && err.message || err) })
    }
  }

  /**
   * 内部策略：将感知事实安全映射至 Heart 自身 Mood 转移候选
   * 杜绝外部指定任意三维增量
   * @private
   */
  _mapObservationToMood(type, source, confidence, evidence, summary) {
    // 置信度过低直接忽略
    if (confidence < 0.3) return null

    if (type === 'sticker') {
      const meaning = (evidence && evidence.meaning) ? String(evidence.meaning).toLowerCase() : ''
      if (meaning === 'comfort' || meaning === 'hug' || meaning === 'love' || meaning === 'praise') {
        return {
          state: 'cheerful',
          intensity: Math.min(0.8, 0.4 + 0.3 * confidence),
          reason: 'positive_interaction',
          why: summary || '收到来自外部的安慰或亲近表情包',
        }
      }
      if (meaning === 'funny' || meaning === 'laugh') {
        return {
          state: 'cheerful',
          intensity: Math.min(0.7, 0.3 + 0.2 * confidence),
          reason: 'positive_interaction',
          why: summary || '有趣的互动表情包',
        }
      }
      return null
    }

    if (type === 'wake') {
      return {
        state: 'engaged',
        intensity: Math.min(0.7, 0.4 + 0.2 * confidence),
        reason: 'focus',
        why: summary || '收到新的唤醒交互',
      }
    }

    if (type === 'activity') {
      const status = (evidence && evidence.status) ? String(evidence.status).toLowerCase() : ''
      if (status === 'completed' || status === 'success') {
        return {
          state: 'engaged',
          intensity: Math.min(0.8, 0.4 + 0.3 * confidence),
          reason: 'task_completed',
          why: summary || '外部活动圆满完成',
        }
      }
      return null
    }

    return null
  }
}
