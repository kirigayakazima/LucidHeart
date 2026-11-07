// @dsh/rvc: 声学参数与 Heart 情绪映射引擎 (lib/acoustic.js)
// 遵循零外部依赖原则，将 Heart Protocol v1 情绪四维向量转换为 RVC / TTS 声学参数。

/**
 * 合法的候选音高集合：
 * 0: P0 元气活泼少女音 (~255.7Hz，与唱歌链同频)
 * -4: P4 沉稳温柔日常音 (~210.1Hz，日常叙事与晚安耳语)
 * 注意：严禁使用 -2 (P2 会导致严重八度跳变颤音，标准差达 97.2Hz)
 */
export const VALID_PITCHES = Object.freeze([0, -4])
export const DEFAULT_TTS_VOICE = 'zh-CN-XiaoxiaoNeural'

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
  const valence = Number.isFinite(mood.valence) ? mood.valence : 0.2
  const arousal = Number.isFinite(mood.arousal) ? mood.arousal : 0.35
  const energy = Number.isFinite(mood.energy) ? mood.energy : 0.6
  const lively = (valence >= 0.5 && arousal >= 0.65) || ['joy', 'excited', 'happy'].includes(state)
  const tired = energy < 0.4 || ['tired', 'sleepy', 'melancholy'].includes(state)

  if (options.pitch === -2) {
    console.warn('[@dsh/rvc] 拦截非法音高 -2 (防八度跳变)，已安全校正为 -4')
  }
  const pitch = options.pitch === 0 || (options.pitch === undefined && lively) ? 0 : -4
  const brightness = Number.isFinite(options.brightness)
    ? Math.max(1.5, Math.min(3.5, options.brightness))
    : tired ? 1.8 : 2.2
  const rate = options.rate ? String(options.rate) : tired ? '-6%' : arousal >= 0.7 ? '+4%' : '+0%'

  // 4. 辅音保护比率
  const protect = 0.33

  return {
    pitch,
    ttsVoice: DEFAULT_TTS_VOICE,
    brightness: Number(brightness.toFixed(1)),
    rate,
    protect,
    emotion: state,
    moodState: state,
    arousal: Number(arousal.toFixed(2)),
    valence: Number(valence.toFixed(2)),
    energy: Number(energy.toFixed(2)),
    pitchName: pitch === 0 ? 'P0 元气活泼少女音 (~255.7Hz)' : 'P4 沉稳温柔日常音 (~210.1Hz)',
    summary: `RVC 音色 (音高: ${pitch === 0 ? 'P0(255Hz)' : 'P4(210Hz)'}, 亮度补偿: ${brightness.toFixed(1)}dB, 语速: ${rate})`,
  }
}

export function readPcm16(wav, sampleRate) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) !== wav.length - 8) {
    throw new Error('Invalid PCM WAV container')
  }
  let validFormat = false
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > wav.length) break
    if (id === 'fmt ' && size >= 16) {
      validFormat = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 &&
        wav.readUInt32LE(start + 4) === sampleRate && wav.readUInt16LE(start + 14) === 16
    }
    if (id === 'data' && validFormat && size > 0 && size % 2 === 0) {
      const samples = new Int16Array(size / 2)
      for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(start + i * 2)
      return samples
    }
    offset = start + size + (size % 2)
  }
  throw new Error('Expected mono PCM16 WAV at the requested sample rate')
}

export function writePcm16(samples, sampleRate) {
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(samples[i], 44 + i * 2)
  return wav
}

export const DRY_SAMPLE_RATE = 16000
export const VOICE_SAMPLE_RATE = 40000
const frameSize = DRY_SAMPLE_RATE / 100
const toVoiceSamples = sample => Math.round(sample * VOICE_SAMPLE_RATE / DRY_SAMPLE_RATE)

export function planVoiceChunks(dry, punctuationSeconds = []) {
  const cuts = [0]
  if (dry.length > 10 * DRY_SAMPLE_RATE) {
    const frames = new Float64Array(Math.ceil(dry.length / frameSize))
    for (let i = 0; i < dry.length; i++) frames[Math.floor(i / frameSize)] += dry[i] ** 2
    const levels = frames.map(sum => Math.sqrt(sum / frameSize))
    const sorted = levels.slice().sort()
    const silence = Math.max(33, Math.min(262, sorted[Math.floor(sorted.length * .9)] * .04))
    const pauses = []
    for (let start = 0, end = 0; start < levels.length; start = end) {
      end = start + 1
      if (levels[start] > silence) continue
      while (end < levels.length && levels[end] <= silence) end++
      if (end - start >= 8) pauses.push(Math.floor((start + end) / 2))
    }
    let start = 0
    // Seven-second centers leave room for inference context below the 8s worker split.
    while (start + 700 < levels.length) {
      const min = start + 300
      const max = start + 700
      const eligible = pauses.filter(frame => frame >= min && frame <= max)
      const punctuated = eligible.filter(frame => punctuationSeconds.some(second =>
        frame >= second * 100 - 5 && frame <= second * 100 + 45))
      let end = punctuated.at(-1) ?? eligible.at(-1)
      if (end === undefined) {
        end = max
        const energy = frame => levels[frame - 1] + levels[frame] + (levels[frame + 1] ?? levels[frame])
        for (let i = max - 150; i < max; i++) if (energy(i) < energy(end)) end = i
      }
      cuts.push(end * frameSize)
      start = end
    }
  }
  cuts.push(dry.length)
  return cuts.slice(1).map((end, i) => ({
    start: cuts[i], end,
    contextStart: Math.max(0, cuts[i] - 30 * frameSize),
    contextEnd: Math.min(dry.length, end + 30 * frameSize),
  }))
}

// Both sides of a join refer to the same original time interval. A complementary
// half-Hann pair sums to one, preserving the pause and the original sample count.
export function joinVoiceChunks(spans, converted) {
  const joined = new Int16Array(toVoiceSamples(spans.at(-1).end))
  const fade = VOICE_SAMPLE_RATE * 0.05
  for (let i = 0; i < spans.length; i++) {
    const { start, end, contextStart, contextEnd } = spans[i]
    const origin = toVoiceSamples(contextStart)
    const first = toVoiceSamples(start)
    const last = toVoiceSamples(end)
    const samples = converted[i]
    if (samples.length < toVoiceSamples(contextEnd) - origin) throw new Error('PC voice chunk lost samples')
    joined.set(samples.subarray(first - origin, last - origin), first)
    if (!i) continue
    const previous = spans[i - 1]
    const previousOrigin = toVoiceSamples(previous.contextStart)
    const radius = Math.min(fade, first - toVoiceSamples(previous.start), last - first)
    for (let k = 0; k < 2 * radius; k++) {
      const pos = first - radius + k
      const gain = .5 - .5 * Math.cos(Math.PI * k / (2 * radius - 1))
      joined[pos] = Math.round(converted[i - 1][pos - previousOrigin] * (1 - gain) + samples[pos - origin] * gain)
    }
  }
  return joined
}
