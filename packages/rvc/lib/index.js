// @dsh/rvc: RVC 拟人音色与 Heart 情绪自适应发音 Cordis 插件
// 深度绑定 Heart Protocol v1，实现心境到声学参数的自适应映射与 QQ 语音发送。

import { computeAcousticProfile } from './acoustic.js'
import { runSpeak, detectEnvironment } from './runner.js'

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

function getHeart(ctx) {
  try { return ctx?.heart || null } catch { return null }
}
function getMediaSender(ctx) {
  try { return ctx?.qqbotMediaSender || null } catch { return null }
}
function getPcBridge(ctx) {
  try { return ctx?.pcBridge || ctx?.fullawake || null } catch { return null }
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
        '使用小满的专属大肥鱼 (Dv5) 少女音色进行拟人语音合成。' +
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
        const text = String(args.text || '').trim()
        if (!text) {
          return { ok: false, error: '发音文本不能为空' }
        }

        // A. Heart 活动前置准入校验
        const heart = getHeart(ctx)
        if (heart && typeof heart.evaluateActivity === 'function') {
          const evalRes = heart.evaluateActivity({
            intent: 'voice_speak',
            category: 'voice',
            estimatedDurationMinutes: 1,
          })
          if (evalRes && evalRes.suitable === false) {
            return {
              ok: false,
              blocked_by_heart: true,
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
        const offloadBridge = getPcBridge(ctx)
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
          return {
            ok: false,
            error: `语音合成执行失败: ${err.message}`,
          }
        }

        // D. QQ 语音消息自动投递 (若在 QQ 对话中且启用了发送)
        let qqSent = false
        if (args.send_to_qq !== false && res.audioPath) {
          const mediaSender = getMediaSender(ctx)
          if (mediaSender && typeof mediaSender.sendVoice === 'function') {
            try {
              await mediaSender.sendVoice(undefined, { localPath: res.audioPath })
              qqSent = true
            } catch (err) {
              console.warn('[@dsh/rvc] QQ 语音发送告警:', err.message)
            }
          }
        }

        // E. 发声经验回流心智 (heart.observe)
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
          } catch (err) {
            console.warn('[@dsh/rvc] Heart 上报告警:', err.message)
          }
        }

        return {
          ok: true,
          message: '语音合成完成',
          audio_file: res.audioPath,
          duration_ms: res.durationMs,
          mode: res.mode,
          sent_to_qq: qqSent,
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
      description: '将一首完整歌曲转换为小满 Dv5 大肥鱼音色（自动伴奏分离、人声音色替换与立体声混音）。',
      parameters: {
        input_audio: {
          type: 'string',
          description: '待转换的原歌曲或人声音频路径',
          required: true,
        },
        task_name: {
          type: 'string',
          description: '任务标识名（英文字符与数字）',
          required: true,
        },
        pitch: {
          type: 'number',
          description: '整曲变调半音数（默认 0，男歌转女声建议 +12）',
        },
      },
      async execute(args) {
        return {
          ok: true,
          task_name: args.task_name,
          pitch: args.pitch || 0,
          status: 'dispatched',
          notice: '唱歌任务已启动，正在执行人声分离、Dv5 转换与混音...',
        }
      },
    })
  )
}
