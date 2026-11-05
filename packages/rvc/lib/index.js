// @dsh/rvc: RVC 拟人音色与 Heart 情绪自适应发音 Cordis 插件
// 深度绑定 Heart Protocol v1，实现心境到声学参数的自适应映射与 QQ 语音发送。

import { computeAcousticProfile } from './acoustic.js'
import { runSpeak, detectEnvironment } from './runner.js'
import { getVoiceServices } from './services.js'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

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
    })
  : undefined

const defaultOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

export function apply(ctx, config = {}) {
  const mock = Boolean(config.mock)
  let latestAcoustic = computeAcousticProfile()

  // 1. 订阅 Heart 状态变化事件 (只读通知，更新活跃声学预备态)
  ctx.on('heart/state-changed', (event) => {
    const mood = event?.current?.mood || event?.mood
    if (mood) {
      latestAcoustic = computeAcousticProfile(mood)
    }
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
        const mood = snapshot?.mood || {}
        let acoustic = Object.keys(mood).length > 0
          ? computeAcousticProfile(mood, { pitch: args.pitch, emotion: args.emotion })
          : { ...latestAcoustic, ...(args.pitch !== undefined ? { pitch: args.pitch } : {}) }

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
              const delivered = await mediaSender.sendVoice(target, { localPath: res.audioPath })
              if (delivered === false || delivered?.ok === false || delivered?.success === false) {
                throw new Error(delivered?.error || 'QQ sender reported delivery failure')
              }
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
      description: '启动完整唱歌转换链（UVR 人声分离 → RVC PC极速分流变声 → 伴奏混音），并在后台异步生成歌曲。如果处于 QQ 会话中，制作完成后会自动发送成曲语音。',
      parameters: {
        input_audio: {
          type: 'string',
          description: '待转换的原歌曲或人声音频路径（例如 /sdcard/rvc/yinghuacao.m4a 或相对歌名）',
          required: true,
        },
        task_name: {
          type: 'string',
          description: '任务标识名（英文字符与数字，例如 yinghuacao）',
          required: true,
        },
        pitch: {
          type: 'number',
          description: '音高调整（0 为元气少女，-4 为沉稳日常，严禁传 -2；默认为 0）',
        },
      },
      async execute(args, exec) {
        const { mediaSender, pcBridge } = getVoiceServices(ctx)
        const taskName = String(args.task_name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
        if (!taskName) return { ok: false, error: 'task_name 必须包含有效英文字符或数字' }
        let pitch = Number(args.pitch) || 0
        if (pitch === -2) pitch = -4
        if (pitch !== 0 && pitch !== -4) pitch = 0

        let inputAudio = String(args.input_audio || '').trim()
        const candidates = [
          inputAudio,
          path.resolve('/sdcard/rvc', inputAudio),
          path.resolve('/sdcard/rvc', `${taskName}.m4a`),
          path.resolve('/sdcard/rvc', `${taskName}.mp3`),
          path.resolve('/sdcard/rvc', `${taskName}.wav`),
        ]
        let resolvedInput = null
        for (const cand of candidates) {
          if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
            resolvedInput = cand
            break
          }
        }
        if (!resolvedInput) {
          return {
            ok: false,
            task_name: taskName,
            status: 'file_not_found',
            error: `未找到原曲音频文件: ${inputAudio}。请确保文件已存放在 /sdcard/rvc/ 目录下。`,
          }
        }

        const scriptCandidates = [
          '/sdcard/rvc/sing-chain.sh',
          path.resolve(new URL('../vendor/phone/sing-chain.sh', import.meta.url).pathname),
        ]
        let scriptPath = null
        for (const sp of scriptCandidates) {
          if (sp && fs.existsSync(sp)) {
            scriptPath = sp
            break
          }
        }
        if (!scriptPath) {
          return {
            ok: false,
            task_name: taskName,
            status: 'script_not_found',
            error: '未找到唱歌流水线脚本 sing-chain.sh',
          }
        }

        const isPcOnline = pcBridge && typeof pcBridge.isOnline === 'function' ? pcBridge.isOnline() : false
        const outDir = `/sdcard/rvc/out/sing_${taskName}`
        const outSong = `${outDir}/song_${taskName}.mp3`

        let target = undefined
        if (mediaSender && typeof mediaSender.resolveTargetForSession === 'function') {
          target = mediaSender.resolveTargetForSession(exec?.agent?.id)
        }

        const child = spawn('bash', [scriptPath, resolvedInput, taskName, String(pitch)], {
          detached: true,
          stdio: 'ignore',
        })
        child.unref()

        child.on('close', async (code) => {
          if (code === 0 && fs.existsSync(outSong)) {
            console.log(`[@dsh/rvc] 唱歌任务 ${taskName} 已完成，产物: ${outSong}`)
            if (mediaSender && typeof mediaSender.sendVoice === 'function' && target) {
              try {
                await mediaSender.sendVoice(target, { localPath: outSong })
                console.log(`[@dsh/rvc] 歌曲 ${taskName} 已自动投递至 QQ`)
              } catch (err) {
                console.warn(`[@dsh/rvc] 歌曲 ${taskName} QQ 投递失败:`, err.message)
              }
            }
          } else {
            console.warn(`[@dsh/rvc] 唱歌任务 ${taskName} 退出码: ${code}`)
          }
        })

        return {
          ok: true,
          task_name: taskName,
          status: 'dispatched',
          input_audio: resolvedInput,
          mode: isPcOnline ? 'pc_offload' : 'phone_local',
          expected_output: outSong,
          notice: `唱歌流水线已在后台启动（${isPcOnline ? '已接通 PC FullAwake 算力分流加速' : 'PC 离线，正在以手机本地 ONNX 慢速运行'}）。成曲后将保存在 ${outSong}，制作完成后会自动发送到当前 QQ 聊天。`,
        }
      },
    })
  )
}
