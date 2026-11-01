// @dsh/qq-plus 插件入口
// 统一管理 QQ 机器人的入站唤醒门控与出站拟人打字节奏，支持小满/阿醒双角色与 Heart Protocol v1 状态联动。

import { Config } from './config.js'
import { splitForQQ } from './split.js'
import {
  resolvePersonaConfig,
  computeHeartCadence,
  XIAOMAN_PROFILE,
  AXING_PROFILE,
} from './personas.js'
import { createWakeGate, wakeGate } from './wake-gate.js'

export const name = 'dsh-qq-plus'
export const inject = ['qqbotSender']
export {
  Config,
  splitForQQ,
  resolvePersonaConfig,
  computeHeartCadence,
  createWakeGate,
  wakeGate,
  XIAOMAN_PROFILE,
  AXING_PROFILE,
}

/**
 * 判断当前出站消息是否满足断句条件：
 * - 启用了断句功能
 * - opts 为空（问答/审批带 keyboard 绝不切分）
 * - 不带跳过前缀（🔧 工具结果、❌ 错误、⚠️ 轮次异常等）
 * - 长度超过 minChars
 * - 不包含超过 3000 字符的超长代码块/表格
 */
export function shouldSplit(content, opts, splitConfig = {}) {
  if (splitConfig.enabled === false) return false
  if (opts?.keyboard) return false
  if (typeof content !== 'string') return false
  const trimmed = content.trim()
  const minChars = splitConfig.minChars ?? 120
  if (trimmed.length < minChars) return false

  const skipPrefixes = Array.isArray(splitConfig.skipPrefixes)
    ? splitConfig.skipPrefixes
    : ['🔧', '❌', '⚠️']
  for (const prefix of skipPrefixes) {
    if (trimmed.startsWith(prefix)) return false
  }

  if (splitConfig.protectCode !== false) {
    const codeMatch = trimmed.match(/^[ \t]*(```|~~~)[\s\S]*?\1/m)
    if (codeMatch && codeMatch[0].length > 3000) return false
    const tableMatch = trimmed.match(/(?:^[ \t]*\|[^\n]+\|[ \t]*(?:\n|$)){2,}/m)
    if (tableMatch && tableMatch[0].length > 3000) return false
  }

  return true
}

/**
 * 向 Heart Protocol v1 上报群聊唤醒感知
 */
export async function reportWakeToHeart(ctx, event = {}) {
  let heart = null
  try {
    heart = ctx?.heart
  } catch {}
  if (!heart || typeof heart.observe !== 'function') return null

  try {
    return await heart.observe({
      type: 'im_wake',
      source: 'qq-plus',
      confidence: 1.0,
      evidence: {
        persona: event.persona,
        hitWord: event.hitWord,
        isMentioned: Boolean(event.isMentioned),
        isCommand: Boolean(event.isCommand),
        group: event.msg?.groupOpenid || undefined,
      },
      summary: event.hitWord
        ? `群聊检测到唤醒词「${event.hitWord}」(${event.persona})`
        : `群聊收到消息指令 (${event.persona})`,
    })
  } catch (err) {
    console.warn('[qq-plus] heart.observe error:', err?.message || err)
    return null
  }
}

export function apply(ctx, rawConfig = {}) {
  const personaConfig = resolvePersonaConfig(ctx, rawConfig)
  console.log(
    `[qq-plus] initialized for [${personaConfig.name} (${personaConfig.role})], device: ${personaConfig.device}, wakeWords: [${personaConfig.wakeWords.join(', ')}]`
  )

  // 1. 出站消息包装：qqbotSender.sendMarkdown
  const sender = ctx && ctx.qqbotSender
  if (sender && typeof sender.sendMarkdown === 'function') {
    const original = sender.sendMarkdown
    sender.sendMarkdown = async (target, content, opts) => {
      // 每次发送动态获取当前最新画像与微调配置
      const currentConfig = resolvePersonaConfig(ctx, rawConfig)
      let effectiveSplit = { ...currentConfig.split }

      // 联动 Heart 情绪与精力状态
      if (currentConfig.heartCadence) {
        try {
          const heart = ctx?.heart
          if (heart && typeof heart.getSnapshot === 'function') {
            const snapshot = heart.getSnapshot()
            effectiveSplit = computeHeartCadence(effectiveSplit, snapshot)
          }
        } catch {}
      }

      if (!shouldSplit(content, opts, effectiveSplit)) {
        return original.call(sender, target, content, opts)
      }

      const isGroup = target && target.scope === 'group'
      const parts = splitForQQ(content, { ...effectiveSplit, isGroup })
      if (parts.length <= 1) {
        return original.call(sender, target, content, opts)
      }

      console.log(
        `[qq-plus] splitting outbound message into ${parts.length} segments (${currentConfig.name}, delay: ${effectiveSplit.delayMs}ms, total ${content.length} chars)`
      )

      for (let i = 0; i < parts.length; i++) {
        // 仅第一段携带引用卡片，后续分段避免重复引用刷屏
        const segmentOpts = i === 0
          ? opts
          : (opts ? { ...opts, quoteReply: false, messageReference: undefined, refMsgId: undefined } : { quoteReply: false })
        try {
          await original.call(sender, target, parts[i], segmentOpts)
        } catch (err) {
          console.error(`[qq-plus] segment ${i + 1}/${parts.length} failed:`, err)
          break
        }
        if (i < parts.length - 1 && effectiveSplit.delayMs > 0) {
          await new Promise((r) => setTimeout(r, effectiveSplit.delayMs))
        }
      }
    }

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        console.log('[qq-plus] unloaded, restoring original sendMarkdown')
        sender.sendMarkdown = original
      })
    }
  } else {
    console.warn('[qq-plus] ctx.qqbotSender not available or invalid, skipping sendMarkdown wrapper')
  }

  // 2. 导出创建唤醒门控实例的工厂方法与唤醒感知上报
  ctx.on?.('qq-plus/wake', (event) => {
    reportWakeToHeart(ctx, event)
  })
}
