// @dsh/rvc: RVC 拟人音色与 Heart 情绪自适应发音 Cordis 插件
// 深度绑定 Heart Protocol v1，实现心境到声学参数的自适应映射与 QQ 语音发送。

import { computeAcousticProfile } from './acoustic.js'
import { runSpeak } from './runner.js'
import { resolveVoiceInstructions } from './breezeblue.js'
import { getOptionalService, getVoiceServices } from './services.js'
import { findSong, PcSongCancelled, queuePcSong, renderSong } from './sing.js'
import fs from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { Artifacts } from './artifacts.js'

const pluginVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const songStageMessage = {
  separation: '满宝去换装准备啦，正在切伴奏哦～',
  rvc: '伴奏准备好啦，满宝开始变声录歌咯～',
  mixing: '录好啦，正在做温暖的母带混音哦～',
}

let defineTool = (t) => t
try {
  const dt = await import('@deepseek-ai/dsh-tools')
  if (typeof dt.defineTool === 'function') defineTool = dt.defineTool
} catch {}

let z = null
try {
  const zm = await import('@deepseek-ai/schemastery')
  z = zm.default || zm
} catch {}

export const name = '@dsh/rvc'

export const inject = ['tools']

export const Config = z
  ? z.object({
      provider: z.string().default('breezeblue').description('发声生成引擎：默认 breezeblue (云端在线真实少女音)'),
      allowLocalFallback: z.boolean().default(false).description('云端 BreezeBlue 失败时是否允许回退至本地 ONNX RVC（默认关闭，防止慢推理与音色突变）'),
      breezeApiKey: z.string().default('brz_XfxyZyDQK9a6Ex5-5l_9W9aJ9cMq9H8j').description('BreezeBlue API 密钥'),
      breezeVoiceId: z.string().default('voc_myarmcyqm2zv').description('BreezeBlue 声音 ID (小满音色)'),
      breezeEndpoint: z.string().default('https://api.breeze.blue/v1/text-to-speech').description('BreezeBlue TTS 服务端点'),
      saveDataset: z.boolean().default(false).description('是否自动将在线合成的人声音频与标注保存至手机 /sdcard/rvc/dataset/（默认关闭以防污染语料库）'),
      datasetDir: z.string().default('/sdcard/rvc/dataset').description('训练语料自动收集目录'),
      modelsDir: z.string().default('/sdcard/rvc/models/feiyu-rvc-v1').description('RVC 移动端 ONNX 权重与检索索引所在目录'),
      voiceProfile: z.string().default('/sdcard/rvc/models/feiyu-rvc-v1/voice-profile.json').description('新音色配置文件路径；默认指向 feiyu-rvc-v1'),
      profilePython: z.string().default('').description('新音色运行环境的 Python 路径'),
      defaultPitch: z.number().default(-4).description('默认基准音高 (0 为活泼少女 255Hz, -4 为沉稳日常 210Hz)'),
      defaultBrightness: z.number().default(0).description('默认高频补偿 (dB)'),
      mock: z.boolean().default(false).description('开发与测试模式 (不调用真实推理)'),
      autoSendQq: z.boolean().default(true).description('在 QQ 会话中调用时是否自动发送语音条'),
      songsDir: z.string().default('/sdcard/rvc').description('点歌原曲与成曲目录'),
    })
  : undefined

const defaultOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

function assertQqDelivery(result) {
  if (result === false || result?.ok === false || result?.success === false) {
    throw new Error(result?.error || 'QQ sender reported delivery failure')
  }
}

async function deliverSong(send, signal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let rejected
    try {
      const result = await send()
      if (result?.status === 429 && result?.ok === false) rejected = result
      else {
        assertQqDelivery(result)
        return
      }
    } catch (error) {
      if ((error?.status ?? error?.statusCode) !== 429 || attempt >= 2) throw error
      rejected = error
    }
    if (attempt >= 2) assertQqDelivery(rejected)
    const delay = Math.max(250, Math.min(5000, Number(rejected.retryAfterMs) || 1000))
    await wait(delay, undefined, { signal })
  }
}

function losslessJson(fn) {
  return async (...args) => {
    const result = await fn(...args)
    if (result === undefined) return {}
    return JSON.parse(JSON.stringify(result))
  }
}

export function apply(ctx, config = {}) {
  const mock = Boolean(config.mock)
  let latestMood = {}
  const songs = new Map()
  const root = path.resolve(config.songsDir || '/sdcard/rvc')
  const songArtifacts = new Artifacts(path.join(root, 'out'))
  const voiceArtifacts = process.platform === 'win32' && !config.songsDir
    ? new Artifacts(path.join(os.homedir(), '.dsh', 'audio', 'rvc-cache')) : songArtifacts
  if (!mock) {
    songArtifacts.sweep()
    if (voiceArtifacts !== songArtifacts) voiceArtifacts.sweep()
  }
  const lifetime = new AbortController()
  ctx.effect?.(() => () => lifetime.abort())

  ctx.effect?.(() => ctx.provide?.('rvcWatchVoice', {
    gameInstructions(text) {
      const mood = getOptionalService(ctx, 'heart')?.getSnapshot?.()?.mood || latestMood
      const acoustic = computeAcousticProfile(mood, {})
      if (!['tired', 'sleepy'].includes(mood?.state)) acoustic.emotion = 'playful'
      return resolveVoiceInstructions(text, acoustic, mood)
    },
    async replyToQq(text, { instructions, execution, targetSession, observe = true } = {}) {
      return speak({ text, instructions, provider: 'breezeblue' }, execution, { game: true, targetSession, observe })
    },
    async prepare(text, { signal, instructions, game = false } = {}) {
      if (mock) throw new Error('Watch requires real RVC audio')
      const activeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
      const { heart, pcBridge } = getVoiceServices(ctx)
      const acoustic = computeAcousticProfile(heart?.getSnapshot?.()?.mood || latestMood, {})
      const result = await runSpeak({
        text,
        acoustic,
        instructions,
        provider: game ? 'breezeblue' : config.provider || 'breezeblue',
        breezeApiKey: config.breezeApiKey,
        breezeVoiceId: config.breezeVoiceId,
        breezeEndpoint: config.breezeEndpoint,
        saveDataset: game ? false : config.saveDataset === true,
        allowLocalFallback: config.allowLocalFallback === true,
        datasetDir: config.datasetDir,
        mood: heart?.getSnapshot?.()?.mood || latestMood,
        modelsDir: config.modelsDir,
        offloadBridge: pcBridge,
        voiceProfile: config.voiceProfile,
        profilePython: config.profilePython,
        signal: activeSignal,
        artifacts: voiceArtifacts,
      })
      try {
        activeSignal.throwIfAborted()
        if (!result.artifactId || (await stat(result.audioPath)).size > 1024 * 1024) throw new Error('Invalid watch audio artifact')
        return await readFile(result.audioPath, { signal: activeSignal })
      } finally {
        try {
          if (result.artifactId) voiceArtifacts.remove(result.audioPath)
        } finally { result.releaseArtifact?.() }
      }
    },
  }))

  // 1. 订阅 Heart 状态变化事件 (只读通知，更新活跃声学预备态)
  ctx.on('heart/state-changed', (event) => {
    const mood = event?.current?.mood || event?.mood
    if (mood) latestMood = mood
  })

  // 2. 注册核心发声工具: rvc_speak
  ctx.tools.register(
    defineTool({
      name: 'rvc_speak',
      output: defaultOutput,
      description:
        '用小满自己的声音说话。当电脑桌宠在线且未静音时（默认 target="auto"），优先直接在电脑桌宠开口说话（不再刷 QQ 语音条）；只有桌宠未连接或用户明确要求发 QQ 语音条时才发 QQ 语音条。' +
        '当前优先使用专属 BreezeBlue 真实少女音色，由系统根据情境与心境状态处理自然的演绎与轻微笑意。' +
        '【主动表达原则】：不必等用户明确要求发语音！当你觉得亲口说一句更贴切、更有趣，或者能更好地传达细微情绪（撒娇打趣、晚安耳语、关心安慰、开心笑出声）时，可以主动使用。' +
        '若用户要求先不要讲话（静音），请勿调用发声或调用 pc_voice_control(muted: true) 后改用文字回复。' +
        '调用成功后，若语音已完整表达内容，无需再用文字机械重复整段话；若发声失败，则自然改用文字回复。',
      parameters: {
        text: {
          type: 'string',
          description: '小满亲口想说的话（台词文本，保持自然真实口语）',
          required: true,
        },
        instructions: {
          type: 'string',
          description: '显式发音演绎要求（可选，如 "轻声耳语"、"带一点笑意" 等，仅 breezeblue 生效；默认根据文本与心境自动推导）',
        },
        provider: {
          type: 'string',
          description: '显式指定发声引擎（可选："breezeblue" 云端真实少女音，或 "rvc-onnx" 手机离线变声；默认使用全局配置）',
        },
        pitch: {
          type: 'number',
          description: '显式音高调整（可选。候选值仅限 0 或 -4：0 为元气少女 255Hz，-4 为温柔日常 210Hz。严禁传 -2）',
        },
        emotion: {
          type: 'string',
          description: '显式情绪覆盖（可选，例如 "joy", "calm", "sleepy", "excited"）',
        },
        target: {
          type: 'string',
          description: '播放出口：auto（默认，PC 桌宠在线时直接由电脑桌宠说话，离线时回退 QQ 语音条）、pc_pet（强制桌宠）或 qq（强制发 QQ 语音条）',
        },
        send_to_qq: {
          type: 'boolean',
          description: '是否通过 QQ 直接作为语音条发送（默认为 true；当 PC 桌宠在线且未显式要求时自动优先走桌宠）',
        },
      },
      execute: losslessJson(speak),
    })
  )

  async function speak(args, exec, { game = false, targetSession, observe = true } = {}) {
    if (exec?.signal?.aborted) return { ok: false, cancelled: true, sent_to_qq: false, heart_observation: 'cancelled', plugin_version: pluginVersion };
    const text = String(args.text || '').trim()
    if (!text) {
      return { ok: false, error: '发音文本不能为空' }
    }

    // A. Heart 活动前置准入校验
    // Resolve for each invocation, so services loaded/reloaded later are used.
    const { heart, mediaSender, pcBridge: offloadBridge } = getVoiceServices(ctx)
    const gameTarget = game && config.autoSendQq !== false &&
      mediaSender?.resolveTargetForSession?.(targetSession ?? exec?.agent?.id)
    if (game && (gameTarget?.scope !== 'c2c' || !gameTarget.targetId || typeof mediaSender?.sendVoice !== 'function')) {
      return { ok: false, sent_to_qq: false, error: '当前会话没有已验证的 QQ 语音投递目标' }
    }
    let activityGate = { origin: 'unknown', reason: 'heart_unavailable' }
    if (heart && typeof heart.evaluateActivity === 'function') {
      let evalRes
      try { evalRes = await heart.evaluateActivity({
        intent: 'voice_speak',
        category: 'voice',
        estimatedDurationMinutes: 1,
      }, { execution: exec }) } catch (error) {
        return { ok: false, error_code: 'HEART_EVALUATION_FAILED',
          error: `Heart 发声门控失败: ${error?.message || String(error)}` }
      }
      activityGate = { origin: evalRes?.origin || 'unknown', reason: evalRes?.reason,
        quotaApplied: evalRes?.quotaApplied,
        ...(typeof evalRes?.quietBypassed === 'boolean' && { quietBypassed: evalRes.quietBypassed }) }
      if (evalRes && evalRes.suitable === false) {
        return {
          ok: false,
          plugin_version: pluginVersion,
          blocked_by_heart: true,
          activity_gate: activityGate,
          reason: evalRes.reason,
          message: `[Heart 门控] 当前时段或设备状态 (${evalRes.reason}) 建议保持静音，已自动降级为文本回复。`,
        }
      }
    }

    // B. 获取 Heart 快照并计算声学参数
    const snapshot = heart && typeof heart.getSnapshot === 'function'
      ? heart.getSnapshot()
      : null
    let acoustic = computeAcousticProfile(snapshot?.mood || latestMood, { pitch: args.pitch, emotion: args.emotion })
    let instructions = args.instructions
    if (activityGate.quietBypassed === true) {
      const requested = typeof instructions === 'string' ? instructions.trim() : ''
      instructions = requested
        ? `${requested}。夜深了，请放轻声音，轻声细语，体贴温柔。`
        : '轻声细语，体贴温柔。'
    }

    // B2. PC 桌宠直出优先与静音开关控制
    if (!game) {
      const targetMode = String(args.target || 'auto').trim().toLowerCase()
      const explicitQq = targetMode === 'qq' || args.send_to_qq === true
      if (!explicitQq && offloadBridge?.isVoiceMuted?.() === true) {
        return {
          ok: false,
          muted: true,
          sent_to_qq: false,
          plugin_version: pluginVersion,
          message: '[PC 静音] 用户当前要求先不要讲话，请仅用简短文字回复。',
        }
      }
      if (!explicitQq && (targetMode === 'pc_pet' || offloadBridge?.isPetVoiceReady?.() === true) && typeof offloadBridge?.speakOnPet === 'function') {
        try {
          const petRes = await offloadBridge.speakOnPet({
            text,
            instructions,
            voiceProfile: 'breezeblue',
            pitchShift: 0,
            signal: exec?.signal,
            agentId: exec?.agent?.id,
            prepareFallback: async (turnSignal) => {
              const prep = await runSpeak({
                text,
                acoustic,
                instructions,
                provider: args.provider || config.provider || 'breezeblue',
                breezeApiKey: config.breezeApiKey,
                breezeVoiceId: config.breezeVoiceId,
                breezeEndpoint: config.breezeEndpoint,
                saveDataset: config.saveDataset === true,
                allowLocalFallback: config.allowLocalFallback === true,
                datasetDir: config.datasetDir,
                mood: snapshot?.mood || latestMood,
                modelsDir: config.modelsDir,
                offloadBridge,
                mock,
                voiceProfile: config.voiceProfile,
                profilePython: config.profilePython,
                signal: turnSignal,
                artifacts: voiceArtifacts,
              })
              try {
                return await readFile(prep.audioPath, { signal: turnSignal })
              } finally {
                try { if (prep.artifactId) voiceArtifacts.remove(prep.audioPath) } finally { prep.releaseArtifact?.() }
              }
            },
          })
          if (petRes?.played) {
            let heartObsStatus = 'skipped'
            if (observe && heart && typeof heart.observe === 'function') {
              try {
                const obsRes = await heart.observe({
                  type: 'audio',
                  source: 'rvc',
                  confidence: 1.0,
                  evidence: {
                    provider: petRes.direct ? 'breezeblue_pc_direct' : 'rvc_pc_pet',
                    delivery: 'pc_pet',
                    textLength: [...text].length,
                  },
                  summary: `小满在电脑桌宠直接开口说了一句（${[...text].length} 字）`,
                  timestamp: new Date().toISOString(),
                })
                heartObsStatus = obsRes?.accepted ? 'accepted' : 'rejected'
              } catch { heartObsStatus = 'error' }
            }
            return {
              ok: true,
              plugin_version: pluginVersion,
              provider: petRes.direct ? 'breezeblue_pc_direct' : 'pc_pet',
              delivered_to: 'pc_pet',
              sent_to_qq: false,
              heart_observation: heartObsStatus,
              message: '已在电脑桌宠直接说出，无需再用文字重复。',
            }
          }
          if (targetMode === 'pc_pet') {
            return {
              ok: false,
              sent_to_qq: false,
              plugin_version: pluginVersion,
              message: `电脑桌宠当前未就绪 (${petRes?.reason || 'unavailable'})，请改用文字回复。`,
            }
          }
        } catch (err) {
          if (exec?.signal?.aborted) {
            return { ok: false, cancelled: true, sent_to_qq: false, heart_observation: 'cancelled', plugin_version: pluginVersion }
          }
          if (targetMode === 'pc_pet') {
            return { ok: false, sent_to_qq: false, plugin_version: pluginVersion, error: `电脑桌宠播放失败: ${err.message}` }
          }
        }
      }
    }

    // C. 执行声音转换 (跨端分流与执行)
    let res
    try {
      res = await runSpeak({
        text,
        acoustic,
        instructions,
        provider: args.provider || config.provider || 'breezeblue',
        breezeApiKey: config.breezeApiKey,
        breezeVoiceId: config.breezeVoiceId,
        breezeEndpoint: config.breezeEndpoint,
        saveDataset: game ? false : config.saveDataset === true,
        allowLocalFallback: config.allowLocalFallback === true,
        datasetDir: config.datasetDir,
        mood: snapshot?.mood || latestMood,
        modelsDir: config.modelsDir,
        offloadBridge,
        mock,
        voiceProfile: config.voiceProfile,
        profilePython: config.profilePython,
        signal: exec?.signal,
        artifacts: voiceArtifacts,
      })
      if (res.acoustic) acoustic = res.acoustic
    } catch (err) {
      if (exec?.signal?.aborted) return { ok: false, cancelled: true, sent_to_qq: false, heart_observation: 'cancelled', plugin_version: pluginVersion };
      return {
        ok: false,
        error: `语音合成执行失败: ${err.message}`,
      }
    }

    if (exec?.signal?.aborted) {
      res.releaseArtifact?.()
      return { ok: false, cancelled: true, plugin_version: pluginVersion,
        audio_file: res.audioPath, sent_to_qq: false, heart_observation: 'cancelled',
        message: '本轮已取消，生成的语音未自动投递。' }
    }
    // D. QQ 语音消息自动投递 (若在 QQ 对话中且启用了发送)
    let qqSent = false
    const qqDelivery = { requested: args.send_to_qq !== false && config.autoSendQq !== false,
      status: 'skipped', reason: config.autoSendQq === false ? 'disabled_by_config' : 'disabled_by_request' }
    if (qqDelivery.requested) {
      try {
        if (!res.audioPath) qqDelivery.reason = 'audio_path_missing'
        else if (!mediaSender || typeof mediaSender.sendVoice !== 'function') {
          qqDelivery.reason = 'qq_media_service_unavailable'
          console.warn('[@dsh/rvc] 已生成语音，但 qqbotMediaSender 尚不可用，未自动投递')
        } else {
          const hasSessionResolver = typeof mediaSender.resolveTargetForSession === 'function'
          const target = game ? gameTarget : hasSessionResolver ? mediaSender.resolveTargetForSession(exec?.agent?.id) : undefined
          if (hasSessionResolver && !target) {
            throw new Error('No QQ target for the actual execution session; refusing to guess the latest peer')
          }
          assertQqDelivery(await mediaSender.sendVoice(target, { localPath: res.audioPath }))
          qqSent = true
          qqDelivery.status = 'sent'
          qqDelivery.reason = 'sent'
        }
      } catch (err) {
        qqDelivery.status = 'failed'
        qqDelivery.reason = 'qq_send_failed'
        qqDelivery.error = String(err?.message || err)
        console.warn('[@dsh/rvc] QQ 语音发送告警:', qqDelivery.error)
      }
    }

    res.releaseArtifact?.()
    // E. 发声经验回流心智 (heart.observe)
    let heartObservation = 'service_unavailable'
    if (observe && heart && typeof heart.observe === 'function') {
      try {
        await heart.observe({
          type: 'audio',
          source: 'rvc',
          confidence: 1.0,
          evidence: {
            ...(game ? { scene: 'game_commentary' } : { text: text.slice(0, 100), audioPath: res.audioPath }),
            durationMs: res.durationMs,
            pitch: acoustic.pitch,
            brightness: acoustic.brightness,
            emotion: acoustic.emotion,
            mode: res.mode,
            profileId: res.profileId,
            voiceId: res.voiceId,
            instructions: res.acoustic?.instructions,
          },
          summary: `通过 ${res.mode || 'RVC'} 合成发声 (${res.mode || 'RVC'}, ${res.voiceId ? '声音 ' + res.voiceId : '音高 ' + acoustic.pitch})`,
          timestamp: new Date().toISOString(),
        })
        heartObservation = 'recorded'
      } catch (err) {
        heartObservation = 'failed'
        console.warn('[@dsh/rvc] Heart 上报告警:', err.message)
      }
    }

    return {
      ok: true,
      plugin_version: pluginVersion,
      message: '语音合成完成',
      audio_file: res.audioPath,
      duration_ms: res.durationMs,
      mode: res.mode,
      ...(res.profileId ? { profileId: res.profileId } : {}),
      ...(res.voiceId ? { voiceId: res.voiceId } : {}),
      ...(res.artifactId ? { artifactId: res.artifactId } : {}),
      ...(res.datasetPath ? { dataset_path: res.datasetPath } : {}),
      offload: res.offload || { attempted: false, status: 'not_applicable' },
      sent_to_qq: qqSent,
      qq_delivery: qqDelivery,
      heart_observation: heartObservation,
      activity_gate: activityGate,
      acoustic: {
        pitch: acoustic.pitch,
        pitch_name: acoustic.pitchName,
        brightness_db: acoustic.brightness,
        emotion: acoustic.emotion,
        ...(res.acoustic?.instructions ? { instructions: res.acoustic.instructions } : {}),
      },
    }
  }

  // 3. 注册唱歌转换工具: rvc_sing
  ctx.tools.register(
    defineTool({
      name: 'rvc_sing',
      output: defaultOutput,
      description: '用户点歌时调用一次并传 song_title。工具会自动在当前 QQ 会话确认、后台制作并发送成曲。用户明确要求电脑外放时传 play_on_pc。',
      parameters: {
        song_title: {
          type: 'string',
          description: '用户点的原曲歌名，例如 樱花草',
        },
        input_audio: {
          type: 'string',
          description: '可选的已知本地原曲音频路径，例如 /sdcard/rvc/yinghuacao.m4a',
        },
        task_name: {
          type: 'string',
          description: '可选的任务标识名，例如 yinghuacao',
        },
        pitch: {
          type: 'number',
          description: '音高调整（0 为元气少女，-4 为沉稳日常，严禁传 -2；默认为 0）',
        },
        play_on_pc: { type: 'boolean', description: '用户明确要求在 PC 桌宠扬声器播放时开启' },
      },
      execute: losslessJson(async function execute(args, exec) {
        const signal = AbortSignal.any([lifetime.signal, ...(exec?.signal ? [exec.signal] : [])])
        if (signal.aborted) return { ok: false, status: 'cancelled' }
        const { heart, mediaSender } = getVoiceServices(ctx)
        const input = String(args.input_audio || '').trim()
        const title = String(args.song_title || '').trim().replace(/^《(.+)》$/, '$1').trim()
        const taskName = String(args.task_name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
        const pitch = args.pitch === -2 || args.pitch === -4 ? -4 : 0
        const source = await findSong(root, input, title, taskName)
        if (!source) return { ok: false, status: 'file_not_found', error: '满宝还没找到这首歌的本地原曲。' }
        if (config.mock) return { ok: false, status: 'mock_disabled', error: '模拟模式不生成歌曲。' }

        const target = config.autoSendQq === false ? undefined : mediaSender?.resolveTargetForSession?.(exec?.agent?.id)
        const qqSender = target && getOptionalService(ctx, 'qqbotSender')
        const playOnPc = args.play_on_pc === true
        const key = JSON.stringify([exec?.agent?.id, source.file, pitch, playOnPc])
        if (songs.has(key)) return songs.get(key)
        let gate
        try {
          gate = await heart?.evaluateActivity?.({
            intent: 'voice_sing', category: 'voice', estimatedDurationMinutes: 1,
          }, { execution: exec })
        } catch {
          return { ok: false, status: 'heart_error', error: '满宝暂时无法确认现在是否适合唱歌。' }
        }
        if (signal.aborted) return { ok: false, status: 'cancelled' }
        if (gate?.suitable === false) return { ok: false, status: 'blocked_by_heart', reason: gate.reason }
        if (songs.has(key)) return songs.get(key)

        const jobId = `${taskName || 'song'}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
        const output = path.join(root, 'out', `sing_${jobId}`, `song_${jobId}.mp3`)
        const job = { source, jobId, pitch, output, signal, modelsDir: config.modelsDir || '/sdcard/rvc/models/feiyu-rvc-v1',
          voiceProfile: config.voiceProfile, artifacts: songArtifacts }
        const result = { ok: true, status: 'dispatched', task_name: taskName || 'song', job_id: jobId,
          input_audio: source.file, expected_output: output, artifactId: songArtifacts.id(output), qq_auto_delivery: Boolean(target),
          notice: target ? '工具负责发送进度和成曲，无需再次确认。' : '成曲会保存到 expected_output。' }
        const ledger = getOptionalService(ctx, 'companion')?.tasks
        if (ledger && exec?.agent) {
          try {
            const scope = exec.agent.session?.id ?? exec.agent.session?.header?.id ?? exec.agent.id
            result.task_id = ledger.create('singing', 'rvc:' + jobId, scope, { title: title || path.parse(source.file).name }).id
          } catch (error) { console.warn('[@dsh/rvc] 任务账本登记失败:', error.message) }
        }
        function track(status, progress, detail) {
          if (!result.task_id) return
          if (progress !== undefined) {
            if (!Number.isInteger(progress) || progress < lastProgress || progress > 100) return
          }
          try { lastProgress = ledger.update(result.task_id, status, progress, detail).progress }
          catch (error) { console.warn('[@dsh/rvc] 任务账本更新失败:', error.message) }
        }
        let lastProgress = 0
        songs.set(key, result)

        async function say(message) {
          if (signal.aborted || !qqSender?.sendMarkdown) return
          try {
            assertQqDelivery(await qqSender.sendMarkdown(target, message, { quoteReply: false }))
          } catch (error) {
            console.warn('[@dsh/rvc] QQ 唱歌播报告警:', error.message)
          }
        }

        async function finish() {
          signal.throwIfAborted()
          track('processing', 0, { result: { phase: 'queued' } })
          job.onStatus = (stage, snapshot) => {
            job.pcReported = true
            const phase = { queued: 0, demucs: 25, rvc_convert: 60, mastering: 90 }[stage]
            if (phase === undefined) return
            track('processing', snapshot.progress ?? phase, { result: { phase: stage, queue_position: snapshot.queuePosition ?? null,
              eta_seconds: snapshot.etaSeconds ?? null, eta_stage: snapshot.etaStage ?? null,
              slice_progress: snapshot.sliceProgress ?? null } })
          }
          let progress = say('小满收到啦，这就去后台翻曲谱~')
          job.onStage = stage => {
            const details = { separation: ['demucs', 25], rvc: ['rvc_convert', 60], mixing: ['mastering', 90] }[stage]
            if (details && !job.pcReported) track('processing', details[1], { result: { phase: details[0] } })
            progress = progress.then(() => say(songStageMessage[stage]))
          }
          let rendered
          let artifact
          try {
            rendered = await renderSong(job, error => {
              track('processing', undefined, { result: { phase: 'local_fallback', fallback_reason: error.message } })
              return progress.then(() => say('姐姐的电脑这次没能接上唱歌管线，满宝试试用手机自己的声音唱，会慢一些哦。'))
            })
            artifact = { output_path: output, degraded_reason: rendered.degradedReason ?? null }
            track('processing', 100, { result: { ...artifact, phase: 'ready_local' } })
            await progress
          } catch (error) {
            track('failed', undefined, { error: signal.aborted || error instanceof PcSongCancelled ? 'cancelled' : String(error.message).slice(0, 450) })
            if (signal.aborted || error instanceof PcSongCancelled) return
            await progress
            if (!signal.aborted) {
              console.warn(`[@dsh/rvc] 唱歌任务 ${jobId} 失败:`, error.message)
              await say('满宝这次没能把歌合成出来，等电脑连好我们再试一次吧。')
            }
            return
          }
          signal.throwIfAborted()
          if (playOnPc) {
            try {
              if (!rendered.remoteJobId) throw new Error('PC artifact unavailable')
              await queuePcSong(rendered.remoteJobId, signal)
            } catch (error) {
              console.warn('[@dsh/rvc] PC 成曲排播失败:', error.message)
              await say('电脑没排上这首歌，成曲已保留。')
            }
          }
          signal.throwIfAborted()
          if (target) {
            track('processing', 100, { result: { ...artifact, phase: 'delivering_qq' } })
            try {
              const audio = { localPath: output }
              const fileName = `${(title || path.parse(source.file).name).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80)}.mp3`
              await deliverSong(() => mediaSender.sendFile ? mediaSender.sendFile(target, audio, { fileName })
                : mediaSender.sendVoice(target, audio), signal)
              track('completed', 100, { result: artifact })
              track('delivered')
            } catch (error) {
              track('failed', undefined, { error: String(error.message).slice(0, 450) })
              console.warn(`[@dsh/rvc] 成曲 ${jobId} QQ 投递失败:`, error.message)
              await say('歌已经唱完啦，可是 QQ 没能把音频送出去。')
            }
          } else track('completed', 100, { result: artifact })
          if (signal.aborted) return
          const mode = rendered.mode === 'phone_onnx_fallback' ? 'phone_local' : rendered.mode
          const execution = rendered.remoteJobId ? { mode: rendered.mode, provider: rendered.provider,
            degradedReason: rendered.degradedReason } : rendered
          await heart?.observe?.({ type: 'audio', source: 'rvc', confidence: 1,
            evidence: { audioPath: output, pitch, mode, artifactId: result.artifactId,
              profileId: rendered.profileId, execution }, summary: '通过 RVC 合成歌曲',
            timestamp: new Date().toISOString() })
        }

        void finish().catch(error => {
          track('failed', undefined, { error: signal.aborted ? 'cancelled' : String(error.message).slice(0, 450) })
          if (!signal.aborted) console.warn('[@dsh/rvc] 唱歌任务收尾告警:', error.message)
        }).finally(() => {
          songs.delete(key)
          if (job.artifactDir) songArtifacts.finish(job.artifactDir)
        })
        return result
      }),
    })
  )
}
