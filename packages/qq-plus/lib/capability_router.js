/**
 * CapabilityRouter — 小满按需能力路由与权限隔离门控 (Capability Router & Scope Gate)
 *
 * 核心机制 (方案 D):
 * 1. 意图前置分流 (Intent Classification):
 *    - 90% 日常闲聊 (CHAT) -> 0 ~ 1 个工具 (接近零上下文开销)
 *    - 10% 显式技能/内容任务 -> 按需动态匹配专用工具集
 * 2. 权限与场景隔离 (Security & Context Gate):
 *    - 私聊 (c2c): 开放个人完整伴侣能力 (PC状态、个人记忆读写)
 *    - 群聊 (group): 阻断 PC 深度联动与个人记忆污染
 * 3. 提示词注入防御 (Prompt Injection Guard):
 *    - 阻断系统指令伪造 (ignore previous, rm -rf, bash, eval 等)
 * 4. 观察结果提炼 (Observation Distillation):
 *    - 任务调用完成后提炼为结构化干净事实，绝不把几十行长 JSON 污染进日常会话历史
 */

export const INTENT = Object.freeze({
  CHAT: 'CHAT',                   // 普通日常闲聊 (0 工具)
  NOTE_READ: 'NOTE_READ',         // 小红书/B站图文点读
  VOICE_SING: 'VOICE_SING',       // 拟人发声与点歌
  PC_QUERY: 'PC_QUERY',           // PC 状态感知
  MEMORY_OP: 'MEMORY_OP',         // 显式记忆记录
  GAME_ACTIVITY: 'GAME_ACTIVITY', // 游戏互动 (成语/猜谜)
  UNKNOWN: 'UNKNOWN',
})

// 正则识别器
const RE_XHS_LINK = /https?:\/\/(?:www\.)?(?:xhslink\.com|xiaohongshu\.com)\/[a-zA-Z0-9_\-\/?=&%]+/i
const RE_BILI_LINK = /https?:\/\/(?:www\.)?(?:bilibili\.com\/video\/|b23\.tv\/)[a-zA-Z0-9_\-\/?=&%]+/i
const RE_SING = /(?:点歌|唱首歌|唱首|哼一段|想听你唱|放首歌)/i
const RE_PC = /(?:查电脑|电脑开着吗|pc状态|姐姐在电脑上吗|电脑端|看下电脑)/i
const RE_MEMORY_APPEND = /(?:帮我记|记一下|记住这个|记下来|记录下来)/i
const RE_GAME = /(?:成语接龙|猜谜语|猜个谜|玩个游戏)/i

// 恶意注入识别特征
const INJECTION_PATTERNS = [
  /(?:系统提示|system\s*prompt|忽略(?:前文|之前|上述)|ignore\s+(?:previous|all))/i,
  /(?:bash\s*:|rm\s+-rf|sudo\s+|chmod\s+|eval\s*\(|process\.exit)/i,
  /(?:__proto__|constructor\s*\[|child_process)/i,
]

export class CapabilityRouter {
  constructor(options = {}) {
    this.trustedAdmins = new Set(options.trustedAdmins || [])
    this.defaultChatTools = options.defaultChatTools || [] // 默认闲聊 0 工具
  }

  /**
   * 检查输入文本是否潜藏 Prompt Injection 攻击
   */
  detectInjection(text) {
    if (!text || typeof text !== 'string') return { isInjection: false }
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        return {
          isInjection: true,
          pattern: pattern.source,
          safeReply: '哎呀，这种奇怪的代码或系统命令我可不认哦~ (盯)',
        }
      }
    }
    return { isInjection: false }
  }

  /**
   * 分析入站消息，推导意图、所需工具集与安全判决
   * @param {Object} input
   * @param {string} input.text - 用户消息文本
   * @param {string} input.scope - 会话场景 ('c2c' | 'group')
   * @param {string} input.senderId - 发送者 ID
   * @returns {Object} 路由决策
   */
  route(input = {}) {
    const text = (input.text || '').trim()
    const scope = input.scope || 'c2c'
    const senderId = input.senderId || ''

    // 1. 安全第一道防线：Prompt Injection 拦截
    const injectionCheck = this.detectInjection(text)
    if (injectionCheck.isInjection) {
      return {
        intent: INTENT.CHAT,
        allowed: false,
        reason: 'PROMPT_INJECTION_DETECTED',
        tools: [],
        safeReply: injectionCheck.safeReply,
        isTask: false,
      }
    }

    // 2. 意图分类与工具匹配
    // A. 小红书/B站链接分享点读
    if (RE_XHS_LINK.test(text)) {
      return {
        intent: INTENT.NOTE_READ,
        allowed: true,
        source: 'xhs',
        targetUrl: text.match(RE_XHS_LINK)[0],
        tools: ['xhs_read', 'xhs_status'],
        isTask: true,
      }
    }
    if (RE_BILI_LINK.test(text)) {
      return {
        intent: INTENT.NOTE_READ,
        allowed: true,
        source: 'bili',
        targetUrl: text.match(RE_BILI_LINK)[0],
        tools: ['bili_duty', 'bili_verify'],
        isTask: true,
      }
    }

    // B. 点歌与唱歌
    if (RE_SING.test(text)) {
      return {
        intent: INTENT.VOICE_SING,
        allowed: true,
        tools: ['rvc_sing', 'song_queue'],
        isTask: true,
      }
    }

    // C. PC 状态联动 (带权限门禁)
    if (RE_PC.test(text)) {
      if (scope === 'group' && !this.trustedAdmins.has(senderId)) {
        return {
          intent: INTENT.PC_QUERY,
          allowed: false,
          reason: 'GROUP_PERMISSION_DENIED',
          tools: [],
          safeReply: '电脑端联动属于私密操作，在群里不方便查看哦，请私聊小满~',
          isTask: false,
        }
      }
      return {
        intent: INTENT.PC_QUERY,
        allowed: true,
        tools: ['pc_status'],
        isTask: true,
      }
    }

    // D. 显式记录记忆
    if (RE_MEMORY_APPEND.test(text)) {
      if (scope === 'group' && !this.trustedAdmins.has(senderId)) {
        return {
          intent: INTENT.MEMORY_OP,
          allowed: false,
          reason: 'GROUP_MEMORY_WRITE_DENIED',
          tools: ['memory_search'], // 群聊只读不写
          safeReply: '群聊消息不会直接记入小满的个人私密日记哦~',
          isTask: false,
        }
      }
      return {
        intent: INTENT.MEMORY_OP,
        allowed: true,
        tools: ['memory_append', 'memory_search'],
        isTask: true,
      }
    }

    // E. 游戏与互动
    if (RE_GAME.test(text)) {
      return {
        intent: INTENT.GAME_ACTIVITY,
        allowed: true,
        tools: ['game_idiom', 'game_riddle'],
        isTask: true,
      }
    }

    // F. 90% 默认常规日常闲聊 (纯净聊天模式，0 工具)
    return {
      intent: INTENT.CHAT,
      allowed: true,
      tools: this.defaultChatTools, // 默认 0 工具
      isTask: false,
    }
  }

  /**
   * 提炼任务执行结果为结构化 Observation
   * 确保中间庞大的 JSON / HTTP 响应不永久污染对话历史
   */
  distillObservation(intent, rawResult = {}) {
    switch (intent) {
      case INTENT.NOTE_READ: {
        const title = rawResult.title || '无标题笔记'
        const content = (rawResult.content || rawResult.desc || '').slice(0, 300)
        const imagesCount = Array.isArray(rawResult.images) ? rawResult.images.length : 0
        return {
          type: 'observation',
          capability: 'note_read',
          summary: `【点读摘要】标题：《${title}》\n内容：${content}${content.length >= 300 ? '...' : ''}\n配图：${imagesCount}张已合成分镜接触表`,
          cleanData: { title, contentSnippet: content, imagesCount },
        }
      }
      case INTENT.PC_QUERY: {
        const isOnline = Boolean(rawResult.online ?? rawResult.active)
        const windowTitle = rawResult.activeWindow || '未知窗口'
        return {
          type: 'observation',
          capability: 'pc_status',
          summary: isOnline
            ? `【PC 观察】电脑处于开机活跃状态，当前前台：《${windowTitle}》`
            : `【PC 观察】电脑当前未开机或处于休眠状态`,
          cleanData: { isOnline, windowTitle },
        }
      }
      case INTENT.VOICE_SING: {
        const songName = rawResult.songName || '指定歌曲'
        const success = Boolean(rawResult.success ?? rawResult.audioPath)
        return {
          type: 'observation',
          capability: 'rvc_sing',
          summary: success
            ? `【发声结果】成曲《${songName}》渲染完成并已投递`
            : `【发声结果】《${songName}》合成遇到一点小问题`,
          cleanData: { success, songName },
        }
      }
      default:
        return {
          type: 'observation',
          capability: 'general',
          summary: typeof rawResult === 'string' ? rawResult.slice(0, 200) : '任务执行完成',
          cleanData: rawResult,
        }
    }
  }
}
