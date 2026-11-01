// 唤醒门控：替代 qqbot 自带的 mention-gate。
// 支持小满/阿醒双角色动态唤醒词、@ 提及与 / 斜杠命令。
// 未唤醒的消息被阻断不进 Agent，但仍会被上游 historyBuffer 计入群上下文缓冲。

import { resolvePersonaConfig } from './personas.js'

function detectAtText(content, botId) {
  if (!botId) return false
  return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`)
}

/**
 * 创建 QQBot 中间件唤醒门控
 * @param {Object} options
 * @param {Function} [options.getConfig] 获取最新配置函数
 * @param {Function} [options.onWake] 唤醒事件回调（用于上报 Heart 感知）
 * @param {string} [options.appId] 机器人 AppId
 * @param {boolean} [options.requireMentionInGroup=true] 群聊是否必须提及或唤醒
 */
export function createWakeGate(options = {}) {
  const {
    getConfig = () => resolvePersonaConfig(null),
    onWake = null,
    appId = '',
    requireMentionInGroup = true,
  } = options

  return async (mCtx, next) => {
    const liveConfig = getConfig()
    const msg = mCtx.message || {}

    // 私聊不设门，全部放行
    if (msg.kind !== 'group') {
      if (mCtx.state) {
        mCtx.state.mention = {
          wasMentioned: true,
          implicit: false,
          shouldAnswer: true,
          reason: 'c2c',
          persona: liveConfig.persona,
        }
      }
      return next()
    }

    const botId = appId || mCtx.bot?.appId || ''
    const content = String(msg.content || '')
    const atByEvent = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
    const atByMentions =
      Array.isArray(msg.mentions) && msg.mentions.some((m) => m?.is_you === true)
    const atByText = detectAtText(content, botId)
    const hitWord = (liveConfig.wakeWords || []).find((w) => content.includes(w)) || ''
    const isCommand = /^\s*\//.test(content)
    const mentioned = atByEvent || atByMentions || atByText
    const shouldAnswer = Boolean(!requireMentionInGroup || mentioned || hitWord || isCommand)

    if (mCtx.state) {
      mCtx.state.mention = {
        wasMentioned: mentioned,
        implicit: Boolean(hitWord) || (isCommand && !mentioned),
        shouldAnswer,
        hitWord: hitWord || null,
        persona: liveConfig.persona,
        reason: shouldAnswer ? 'passthrough' : 'no_mention',
      }
    }

    if (!shouldAnswer) {
      mCtx.log?.debug?.(
        `[qq-plus:wake] skip group message: neither @ nor wake-words matched (${liveConfig.persona})`
      )
      mCtx.stop?.('wake-gate:no_mention')
      return
    }

    // 触发唤醒回调（若带有唤醒词，供 Heart 感知记录）
    if (onWake && (hitWord || mentioned || isCommand)) {
      try {
        onWake({
          hitWord: hitWord || null,
          isMentioned: mentioned,
          isCommand,
          content,
          persona: liveConfig.persona,
          msg,
          mCtx,
        })
      } catch (err) {
        console.warn('[qq-plus:wake] onWake callback error:', err)
      }
    }

    return next()
  }
}

// 兼容老版直接引入 wakeGate 的签名
export function wakeGate(opts = {}) {
  return createWakeGate(opts)
}
