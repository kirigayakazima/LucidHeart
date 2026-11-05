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
import { optionalService } from './services.js'
import { createDeliveryQueue, targetKey, waitForDelay, cancelled } from './delivery.js'

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
  if (trimmed.length < minChars && !(splitConfig.semanticParagraphs && /\n\s*\n/.test(trimmed))) return false

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
  const heart = optionalService(ctx, 'heart')
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
    const originalOpenStream = sender.openStream
    const originalCancel = sender.cancelConversation
    const originalDescribe = sender.describeConversation
    const originalDiagnostics = sender.conversationDiagnostics
    const queue = createDeliveryQueue()
    const streams = new Set()
    const diagnostics = { version: 'conversation-v1', sends: 0, cancelled: 0, failures: 0,
      heart: 'not-probed', staticPlans: 0, semanticStreams: 0, nativeStreams: 0 }
    const wrapped = async (target, content, opts) => {
      try { return await queue.enqueue(target, async (signal) => {
        // 每次发送动态获取当前最新画像与微调配置
        const currentConfig = resolvePersonaConfig(ctx, rawConfig)
        let effectiveSplit = { ...currentConfig.split, semanticParagraphs: currentConfig.semanticParagraphs }

        // 联动 Heart 情绪与精力状态
        if (currentConfig.heartCadence) {
          try {
            const heart = optionalService(ctx, 'heart')
            diagnostics.heart = heart ? 'available' : 'unavailable'
            if (heart && typeof heart.getSnapshot === 'function') {
              const snapshot = heart.getSnapshot()
              effectiveSplit = computeHeartCadence(effectiveSplit, snapshot)
            }
          } catch { diagnostics.heart = 'snapshot-failed' }
        }
        const isGroup = target && target.scope === 'group'
        const parts = shouldSplit(content, opts, effectiveSplit)
          ? splitForQQ(content, { ...effectiveSplit, isGroup }) : [content]
        diagnostics.staticPlans++
        // Internal cancellation metadata must never be serialized to the platform.
        const cleanOpts = opts ? { ...opts } : undefined
        if (cleanOpts) { delete cleanOpts.signal; delete cleanOpts.companionDelivery }
        let result
        for (let i = 0; i < parts.length; i++) {
          if (signal.aborted) throw cancelled()
          // 仅第一段携带引用卡片，后续分段避免重复引用刷屏
          const segmentOpts = i === 0
            ? cleanOpts
            : (cleanOpts ? { ...cleanOpts, quoteReply: false, messageReference: undefined, refMsgId: undefined } : { quoteReply: false })
          result = await original.call(sender, target, parts[i], segmentOpts)
          if (result === false || result?.ok === false || result?.success === false) throw new Error(result?.error || 'Platform sender reported failure')
          diagnostics.sends++
          if (i < parts.length - 1 && effectiveSplit.delayMs > 0) {
            await waitForDelay(Math.min(3000, effectiveSplit.delayMs), signal)
          }
        }
        return result
      }, opts?.signal) } catch (error) {
        if (error?.name === 'AbortError') { diagnostics.cancelled++; return { ok: false, cancelled: true } }
        diagnostics.failures++
        throw error // Partial sends are failures; never swallow and let the caller report success.
      }
    }
    sender.sendMarkdown = wrapped
    const cancelConversation = (target) => {
      queue.cancel(target)
      for (const stream of streams) if (stream.key === targetKey(target)) stream.abort()
      originalCancel?.call(sender, target)
    }
    sender.cancelConversation = cancelConversation
    const describe = (target) => {
      const config = resolvePersonaConfig(ctx, rawConfig)
      const policy = optionalService(ctx, 'heart')?.getExpressionPolicy?.()
      return { version: 'conversation-v1', channel: target?.scope === 'group' ? 'group' : 'c2c',
        deliveryMode: config.deliveryMode, expressionEnabled: policy?.enabled ?? false,
        scene: policy?.mode ?? 'off', promptChars: policy?.chars ?? 0,
        text: policy?.enabled ? `当前通道为QQ${target?.scope === 'group' ? '群聊（只使用此群可见背景）' : '私聊'}；表达策略${policy.version}，场景${policy.mode}。自然换段即可，投递层负责气泡节奏。` : '' }
    }
    sender.describeConversation = describe
    const getDiagnostics = () => ({ ...diagnostics, queueTargets: queue.size, activeStreams: streams.size,
      deliveryMode: resolvePersonaConfig(ctx, rawConfig).deliveryMode })
    sender.conversationDiagnostics = getDiagnostics
    const openStream = (target, options = {}) => {
      const mode = resolvePersonaConfig(ctx, rawConfig).deliveryMode
      if (mode === 'native-stream' && typeof originalOpenStream === 'function') {
        diagnostics.nativeStreams++
        return originalOpenStream.call(sender, target, options)
      }
      diagnostics.semanticStreams++
      let text = '', ended = false, aborted = false
      const stream = {
        key: targetKey(target),
        async update(value) { if (!ended && !aborted) text = String(value) },
        async complete() {
          if (ended || aborted) return
          ended = true
          try { if (text.trim()) return await wrapped(target, text, { signal: options.signal }) }
          finally { streams.delete(stream); options.signal?.removeEventListener('abort', stream.abort) }
        },
        abort() { aborted = true; text = ''; streams.delete(stream); options.signal?.removeEventListener('abort', stream.abort) },
      }
      if (options.signal?.aborted) stream.abort()
      else { streams.add(stream); options.signal?.addEventListener('abort', stream.abort, { once: true }) }
      return stream
    }
    sender.openStream = openStream

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        console.log('[qq-plus] unloaded, restoring original sendMarkdown')
        queue.dispose()
        for (const stream of streams) stream.abort()
        if (sender.sendMarkdown === wrapped) sender.sendMarkdown = original
        if (sender.openStream === openStream) sender.openStream = originalOpenStream
        if (sender.cancelConversation === cancelConversation) sender.cancelConversation = originalCancel
        if (sender.describeConversation === describe) sender.describeConversation = originalDescribe
        if (sender.conversationDiagnostics === getDiagnostics) sender.conversationDiagnostics = originalDiagnostics
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
