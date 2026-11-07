// @dsh/rvc: RVC 拟人音色与 Heart 情绪自适应发音 Cordis 插件
// 深度绑定 Heart Protocol v1，实现心境到声学参数的自适应映射与 QQ 语音发送。

import { computeAcousticProfile } from './acoustic.js'
import { runSpeak } from './runner.js'
import { getOptionalService, getVoiceServices } from './services.js'
import { findSong, renderSong } from './singing.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { Artifacts } from './artifacts.js'

const pluginVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

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
      modelsDir: z.string().default('/sdcard/rvc/models/feiyu-rvc-v1').description('RVC 移动端 ONNX 权重与检索索引所在目录'),
      voiceProfile: z.string().default('/sdcard/rvc/models/feiyu-rvc-v1/voice-profile.json').description('新音色配置文件路径；默认指向 feiyu-rvc-v1'),
      profilePython: z.string().default('').description('新音色运行环境的 Python 路径'),
      defaultPitch: z.number().default(0).description('默认基准音高 (0 为活泼少女 255Hz, -4 为沉稳日常 210Hz)'),
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
        '使用已配置的专属音色进行拟人语音合成（当前默认 Feiyu）。' +
        '连续模式的长语音自动按停顿分段变声并合并，无需为了十秒上限删减文字。' +
        '系统会自动根据小满当前的 Heart 心情状态（开朗/平静/疲惫）自适应调整音高 (255Hz 或 210Hz)、高频通透度与语速。' +
        '若在 QQ 会话中且启用了 send_to_qq，生成的音频会自动以原生 QQ 语音条格式送达。',
      parameters: {
        text: {
          type: 'string',
          description: '小满要说的话（文本内容）',
          required: true,
        },
        pitch: {
          type: 'number',
          description: '显式音高调整（可选。候选值仅限 0 或 -4：0 为元气少女 255Hz，-4 为温柔日常 210Hz。严禁传 -2）',
        },
        emotion: {
          type: 'string',
          description: '显式情绪覆盖（可选，例如 "joy", "calm", "sleepy", "excited"）',
        },
        send_to_qq: {
          type: 'boolean',
          description: '是否通过 QQ 直接作为语音条发送（默认为 true）',
        },
      },
      async execute(args, exec) {
        if (exec?.signal?.aborted) return { ok: false, cancelled: true, sent_to_qq: false, heart_observation: 'cancelled', plugin_version: pluginVersion };
        const text = String(args.text || '').trim()
        if (!text) {
          return { ok: false, error: '发音文本不能为空' }
        }

        // A. Heart 活动前置准入校验
        // Resolve for each invocation, so services loaded/reloaded later are used.
        const { heart, mediaSender, pcBridge: offloadBridge } = getVoiceServices(ctx)
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
            quotaApplied: evalRes?.quotaApplied }
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

        // C. 执行声音转换 (跨端分流与执行)
        let res
        try {
          res = await runSpeak({
            text,
            acoustic,
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
              const target = hasSessionResolver ? mediaSender.resolveTargetForSession(exec?.agent?.id) : undefined
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
        if (heart && typeof heart.observe === 'function') {
          try {
            await heart.observe({
              type: 'audio',
              source: 'rvc',
              confidence: 1.0,
              evidence: {
                text: text.slice(0, 100),
                audioPath: res.audioPath,
                durationMs: res.durationMs,
                pitch: acoustic.pitch,
                brightness: acoustic.brightness,
                emotion: acoustic.emotion,
                mode: res.mode,
                profileId: res.profileId,
              },
              summary: `通过 RVC 合成发声 (${res.mode}, 音高 ${acoustic.pitch})`,
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
          profileId: res.profileId,
          artifactId: res.artifactId,
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
          },
        }
      },
    })
  )

  // 3. 注册唱歌转换工具: rvc_sing
  ctx.tools.register(
    defineTool({
      name: 'rvc_sing',
      output: defaultOutput,
      description: '用户自然点歌（例如“唱一首樱花草吧”）时调用一次，直接传 song_title。只使用已有本地原曲。工具会自动在当前 QQ 会话确认、在后台制作并发送完整成曲，无需重复确认或等待结果。',
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
      },
      async execute(args, exec) {
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
        const key = JSON.stringify([exec?.agent?.id, source.file, pitch])
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
          await say('好呀，满宝来唱！我先用电脑准备伴奏和变声，顺利的话大约一分钟哦～')
          signal.throwIfAborted()
          let rendered
          try {
            rendered = await renderSong(job, () => say('姐姐的电脑这次没能接上唱歌管线，满宝试试用手机自己的声音唱，会慢一些哦。'))
          } catch (error) {
            if (!signal.aborted) {
              console.warn(`[@dsh/rvc] 唱歌任务 ${jobId} 失败:`, error.message)
              await say('满宝这次没能把歌合成出来，等电脑连好我们再试一次吧。')
            }
            return
          }
          signal.throwIfAborted()
          if (target) {
            try {
              const audio = { localPath: output }
              const fileName = `${(title || path.parse(source.file).name).replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80)}.mp3`
              const sent = mediaSender.sendFile ? await mediaSender.sendFile(target, audio, { fileName })
                : await mediaSender.sendVoice(target, audio)
              assertQqDelivery(sent)
            } catch (error) {
              console.warn(`[@dsh/rvc] 成曲 ${jobId} QQ 投递失败:`, error.message)
              await say('歌已经唱完啦，可是 QQ 没能把音频送出去。')
            }
          }
          if (signal.aborted) return
          const mode = rendered.mode === 'phone_onnx_fallback' ? 'phone_local' : rendered.mode
          await heart?.observe?.({ type: 'audio', source: 'rvc', confidence: 1,
            evidence: { audioPath: output, pitch, mode, artifactId: result.artifactId,
              profileId: rendered.profileId, execution: rendered }, summary: '通过 RVC 合成歌曲',
            timestamp: new Date().toISOString() })
        }

        void finish().catch(error => {
          if (!signal.aborted) console.warn('[@dsh/rvc] 唱歌任务收尾告警:', error.message)
        }).finally(() => {
          songs.delete(key)
          if (job.artifactDir) songArtifacts.finish(job.artifactDir)
        })
        return result
      },
    })
  )
}
