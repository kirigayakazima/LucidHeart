// 小满（妹妹）与阿醒（姐姐）双角色预设画像与动态判定解析器
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 小满（妹妹·常驻红米手机）画像预设 */
export const XIAOMAN_PROFILE = Object.freeze({
  id: 'xiaoman',
  name: '小满',
  role: '妹妹',
  device: 'phone',
  wakeWords: ['小满', '妹妹', '满宝', '小满同学'],
  split: {
    enabled: true,
    minChars: 100,
    targetChars: 60,
    maxSegments: 4,
    groupMaxSegments: 2,
    delayMs: 600,
    protectCode: true,
    skipPrefixes: ['🔧', '❌', '⚠️'],
  },
  heartCadence: true,
})

/** 阿醒（姐姐·运行在 Windows PC）画像预设 */
export const AXING_PROFILE = Object.freeze({
  id: 'axing',
  name: '阿醒',
  role: '姐姐',
  device: 'win',
  wakeWords: ['阿醒', '姐姐', '醒醒', '醒宝'],
  split: {
    enabled: true,
    minChars: 140,
    targetChars: 90,
    maxSegments: 3,
    groupMaxSegments: 2,
    delayMs: 1000,
    protectCode: true,
    skipPrefixes: ['🔧', '❌', '⚠️'],
  },
  heartCadence: true,
})

/** 宿主特征自动探测（环境探针，零依赖） */
export function detectHostPersona({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  fsModule = fs,
} = {}) {
  // 1. 显式环境变量优先
  const explicit = String(env.DSH_PERSONA || env.DSH_ROLE || '').trim().toLowerCase()
  if (explicit === 'xiaoman' || explicit === '妹妹') return 'xiaoman'
  if (explicit === 'axing' || explicit === '姐姐') return 'axing'

  // 2. Windows 宿主（阿醒大本营）
  if (platform === 'win32') return 'axing'

  // 3. Android / DSHA 容器特征探测（小满大本营）
  try {
    const bridgeHeader = path.join(homedir, '.dsh', '.bridge_headers')
    if (fsModule.existsSync(bridgeHeader)) return 'xiaoman'
  } catch {}

  if (env.DSH_HEART_BODY === 'phone') return 'xiaoman'
  if (env.PREFIX && env.PREFIX.includes('com.termux')) return 'xiaoman'

  // 4. Linux 默认视为小满（手机 Proot Ubuntu 容器）
  if (platform === 'linux') return 'xiaoman'

  return 'axing'
}

let fileCache = { file: '', mtimeMs: -1, data: null }

/** 读取本地动态微调文件（支持热重载，无需重启 DSH） */
export function loadLocalConfigOverride({
  env = process.env,
  homedir = os.homedir(),
  fsModule = fs,
} = {}) {
  if (env.DSH_QQ_IGNORE_LOCAL_FILE === '1') {
    return null
  }

  const targetFile =
    env.DSH_QQ_CONFIG_FILE ||
    path.join(homedir, '.dsh', 'qq-plus.json')
  const legacyFile = path.join(homedir, '.dsh', 'qqbot-wake.json')

  let activeFile = targetFile
  let isLegacy = false
  let stat = null

  try {
    stat = fsModule.statSync(targetFile)
  } catch {
    try {
      stat = fsModule.statSync(legacyFile)
      activeFile = legacyFile
      isLegacy = true
    } catch {
      stat = null
    }
  }

  if (!stat) {
    fileCache = { file: '', mtimeMs: -1, data: null }
    return null
  }

  if (fileCache.data && fileCache.file === activeFile && fileCache.mtimeMs === stat.mtimeMs) {
    return fileCache.data
  }

  try {
    const raw = JSON.parse(fsModule.readFileSync(activeFile, 'utf8'))
    const wrapped = { ...raw, _isLegacy: isLegacy }
    fileCache = { file: activeFile, mtimeMs: stat.mtimeMs, data: wrapped }
    return wrapped
  } catch {
    return null
  }
}

/**
 * 四层级联判定当前角色画像与配置
 */
export function resolvePersonaConfig(ctx, userConfig = {}) {
  // 1. 第一层：用户插件显式配置
  let personaId = String(userConfig.persona || '').trim().toLowerCase()

  // 2. 第二层：Heart 服务契约快照探针
  if (!personaId || personaId === 'auto') {
    try {
      const heartDevice = ctx?.heart?.getSnapshot?.()?.device
      if (heartDevice === 'phone') {
        personaId = 'xiaoman'
      } else if (heartDevice === 'win') {
        personaId = 'axing'
      }
    } catch {}
  }

  // 3. 第三层：宿主环境特征探针
  const hostPersona = detectHostPersona()
  if (!personaId || personaId === 'auto') {
    personaId = hostPersona
  }

  const baseProfile = personaId === 'xiaoman' ? XIAOMAN_PROFILE : AXING_PROFILE
  const localOverride = userConfig.ignoreLocalFile ? {} : (loadLocalConfigOverride() || {})

  // 本地文件微调：支持按角色区分，也支持针对本机的顶层微调
  const personaFileConfig = localOverride[personaId] || {}
  const personaFileWords = personaFileConfig.words || personaFileConfig.wakeWords

  let wakeWords = [...baseProfile.wakeWords]
  if (Array.isArray(userConfig.wakeWords) && userConfig.wakeWords.length > 0) {
    wakeWords = userConfig.wakeWords
  } else if (Array.isArray(personaFileWords) && personaFileWords.length > 0) {
    wakeWords = personaFileWords
  } else if (
    Array.isArray(localOverride.words) &&
    localOverride.words.length > 0 &&
    // 如果是遗留单文件（如 qqbot-wake.json），只在该文件属于当前宿主角色时生效，避免 PC 的阿醒配置覆盖了手机小满测试
    (!localOverride._isLegacy || hostPersona === personaId)
  ) {
    wakeWords = localOverride.words
  } else if (
    Array.isArray(localOverride.wakeWords) &&
    localOverride.wakeWords.length > 0 &&
    (!localOverride._isLegacy || hostPersona === personaId)
  ) {
    wakeWords = localOverride.wakeWords
  }
  const cleanWakeWords = Array.from(new Set(wakeWords.map((w) => String(w).trim()).filter(Boolean)))

  // 兼容平铺配置（允许在 config 顶层直接配置 minChars 等，同时优先继承 userConfig.split）
  const userFlatSplit = {}
  if (userConfig.minChars !== undefined) userFlatSplit.minChars = userConfig.minChars
  if (userConfig.targetChars !== undefined) userFlatSplit.targetChars = userConfig.targetChars
  if (userConfig.maxSegments !== undefined) userFlatSplit.maxSegments = userConfig.maxSegments
  if (userConfig.groupMaxSegments !== undefined) userFlatSplit.groupMaxSegments = userConfig.groupMaxSegments
  if (userConfig.delayMs !== undefined) userFlatSplit.delayMs = userConfig.delayMs
  if (userConfig.enabled !== undefined) userFlatSplit.enabled = userConfig.enabled
  if (userConfig.protectCode !== undefined) userFlatSplit.protectCode = userConfig.protectCode
  if (userConfig.skipPrefixes !== undefined) userFlatSplit.skipPrefixes = userConfig.skipPrefixes

  // 合并出站切分参数
  const splitConfig = {
    ...baseProfile.split,
    ...userFlatSplit,
    ...(userConfig.split || {}),
    ...(localOverride.split || {}),
    ...(personaFileConfig.split || {}),
  }

  return {
    persona: baseProfile.id,
    name: baseProfile.name,
    role: baseProfile.role,
    device: baseProfile.device,
    wakeWords: cleanWakeWords,
    split: splitConfig,
    heartCadence: userConfig.heartCadence ?? baseProfile.heartCadence,
    source: personaId,
  }
}

/**
 * 依据 Heart Protocol v1 快照动态计算打字节奏与延迟
 */
export function computeHeartCadence(baseSplitConfig, heartSnapshot) {
  if (!heartSnapshot || !heartSnapshot.mood) {
    return baseSplitConfig
  }

  const mood = heartSnapshot.mood
  const energy = typeof mood.energy === 'number' ? mood.energy : 0.6
  const arousal = typeof mood.arousal === 'number' ? mood.arousal : 0.3

  let delayMs = baseSplitConfig.delayMs ?? 600
  let targetChars = baseSplitConfig.targetChars ?? 60
  let maxSegments = baseSplitConfig.maxSegments ?? 4

  // 精力偏低 / 疲倦状态 (energy < 0.35)：说话更简洁，打字停顿拉长，减少碎消息气泡
  if (energy < 0.35) {
    delayMs = Math.round(delayMs * 1.35)
    maxSegments = Math.min(maxSegments, 2)
  }
  // 情绪激动 / 兴奋状态 (arousal > 0.65)：打字速度加快，气泡连珠炮
  else if (arousal > 0.65) {
    delayMs = Math.max(250, Math.round(delayMs * 0.7))
    targetChars = Math.max(35, Math.round(targetChars * 0.85))
  }

  return {
    ...baseSplitConfig,
    delayMs,
    targetChars,
    maxSegments,
    _heartAdjusted: true,
  }
}
