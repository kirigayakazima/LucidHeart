// @dsh/rvc: 声学参数与 Heart 情绪映射引擎 (lib/acoustic.js)
// 遵循零外部依赖原则，将 Heart Protocol v1 情绪四维向量转换为 RVC / TTS 声学参数。

/**
 * 合法的候选音高集合：
 * 0: P0 元气活泼少女音 (~255.7Hz，与唱歌链同频)
 * -4: P4 沉稳温柔日常音 (~210.1Hz，日常叙事与晚安耳语)
 * 注意：严禁使用 -2 (P2 会导致严重八度跳变颤音，标准差达 97.2Hz)
 */
export const VALID_PITCHES = Object.freeze([0, -4])

/**
 * 根据 Heart Mood 快照与显式选项计算最终声学配置
 *
 * @param {object} [mood] Heart 情绪对象，格式来自 heart.getSnapshot().mood
 * @param {object} [options] 用户或 Agent 显式覆盖选项
 * @param {number} [options.pitch] 显式指定的音高 (0 或 -4)
 * @param {string} [options.emotion] 显式指定的情绪状态名
 * @param {number} [options.brightness] 显式指定的高频补偿 (dB)
 * @param {string} [options.rate] 显式指定的语速 (例如 "+5%")
 * @returns {object} 计算后的完整声学参数包
 */
export function computeAcousticProfile(mood = {}, options = {}) {
  const state = String(options.emotion || mood.state || 'calm').toLowerCase()
  const valence = typeof mood.valence === 'number' ? mood.valence : 0.2
  const arousal = typeof mood.arousal === 'number' ? mood.arousal : 0.35
  const energy = typeof mood.energy === 'number' ? mood.energy : 0.6

  // 1. 计算音高 (Pitch)
  let pitch = -4 // 默认为平稳沉稳日常音
  if (typeof options.pitch === 'number') {
    if (options.pitch === -2) {
      // 拦截踩坑：八度跳变防护
      console.warn('[@dsh/rvc] 拦截非法音高 -2 (防八度跳变)，已安全校正为 -4')
      pitch = -4
    } else if (VALID_PITCHES.includes(options.pitch)) {
      pitch = options.pitch
    } else {
      // 若传入其他自定义数字，若偏高贴近 0，偏低贴近 -4
      pitch = options.pitch >= -2 ? 0 : -4
    }
  } else {
    // 心境自适应计算：
    const livelyStates = new Set(['joy', 'excited', 'curious', 'amused', 'playful', 'happy'])
    if (arousal >= 0.5 || livelyStates.has(state)) {
      pitch = 0
    } else {
      pitch = -4
    }
  }

  // 2. 计算高频亮度补偿 (Brightness dB, 7kHz 补偿)
  let brightness = 2.5
  if (typeof options.brightness === 'number') {
    brightness = Math.max(1.5, Math.min(3.5, Number(options.brightness)))
  } else {
    if (energy < 0.4 || ['tired', 'sleepy', 'melancholy'].includes(state)) {
      brightness = 2.0 // 柔和低频，消除刺耳感
    } else if (energy > 0.7 && valence > 0.2) {
      brightness = 2.8 // 清脆明朗
    } else {
      brightness = 2.5 // 基准补偿
    }
  }

  // 3. 计算 TTS 前置语速 (Rate)
  let rate = '+0%'
  if (options.rate) {
    rate = String(options.rate)
  } else {
    if (arousal >= 0.65) {
      rate = '+6%'
    } else if (arousal >= 0.5) {
      rate = '+3%'
    } else if (arousal <= 0.3 || ['tired', 'sleepy'].includes(state)) {
      rate = '-8%'
    } else {
      rate = '+0%'
    }
  }

  // 4. 辅音保护比率
  const protect = 0.33

  return {
    pitch,
    brightness: Number(brightness.toFixed(1)),
    rate,
    protect,
    emotion: state,
    moodState: state,
    arousal: Number(arousal.toFixed(2)),
    valence: Number(valence.toFixed(2)),
    energy: Number(energy.toFixed(2)),
    pitchName: pitch === 0 ? 'P0 元气活泼少女音 (~255.7Hz)' : 'P4 沉稳温柔日常音 (~210.1Hz)',
    summary: `Dv5 大肥鱼音色 (音高: ${pitch === 0 ? 'P0(255Hz)' : 'P4(210Hz)'}, 亮度补偿: ${brightness.toFixed(1)}dB, 语速: ${rate})`,
  }
}
