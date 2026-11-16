// dsh-fullawake: FullAwake PC 感官与能力扩展适配插件
// 运行在手机 DSHA 侧，桥接 PC Gateway 暴露的 MCP 视觉与安全文件能力，
// 并基于 Heart Protocol v1 向 Heart 汇报 PC 在线/离线与设备感官观察。

import { registerWatch } from './watch.js'
import { registerTaskView } from './task_view.js'
import { FullAwakeBridgeClient } from './bridge-client.js'
import { GAME_VOICE_DIRECTION, gameWatchTurn } from './game_watch.js'

let compileTool = (t) => t
try {
  const dt = await import('@deepseek-ai/dsh-tools')
  if (typeof dt.defineTool === 'function') compileTool = dt.defineTool
} catch {}

function defineTool(spec) {
  return compileTool({ ...spec, async execute(...args) {
    return JSON.parse(JSON.stringify(await spec.execute(...args)))
  } })
}

let z = null
try {
  const zm = await import('@deepseek-ai/schemastery')
  z = zm.default || zm
} catch {}

export const name = 'dsh-fullawake'

export const inject = ['tools']

export const Config = z
  ? z.object({
      gatewayUrl: z.string().default('http://127.0.0.1:28765').description('FullAwake PC Gateway URL'),
      authToken: z.string().default('').description('Bearer Token，留空时读取 FULLAWAKE_AUTH_TOKEN 或内置默认值'),
      pollIntervalSeconds: z.number().default(30).description('PC 在线状态心跳轮询间隔 (秒)'),
      watchProvider: z.string().default('').description('自动陪看的 DSH 视觉模型提供者'),
      watchModel: z.string().default('').description('自动陪看的 DSH 视觉模型'),
      watchDecisionMode: z.union(['legacy', 'shadow', 'heart']).default('legacy').description('陪看决策模式'),
      voiceEpochProtocol: z.boolean().default(false).description('启用桌宠语音租约与本地打断'),
      bridgeUrl: z.string().default('').description('语音桥回环地址，留空从 gatewayUrl 推导'),
      duplexTarget: z.string().default('').description('接收 PC 麦克风定稿的明确 DSH agent ID，留空关闭'),
      gameWatchQqSessions: z.array(z.string()).default([]).description('允许点播前台游戏的本人 QQ 私聊 session ID'),
    })
  : undefined

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { message: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

const snapshotOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      message: { type: 'string', required: true },
      images: {
        type: 'array',
        items: { type: 'json' },
        description: '截屏图像附件列表',
      },
    },
  },
  render: (_args, value) => {
    const blocks = []
    if (Array.isArray(value?.images)) {
      for (const attachment of value.images) {
        if (attachment) blocks.push({ type: 'image', attachment })
      }
    }
    if (value?.message) {
      blocks.push({ type: 'text', text: value.message })
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text: '截屏成功' }]
  },
}

export function apply(ctx, config = {}) {
  const gatewayUrl = String(config.gatewayUrl || process.env.FULLAWAKE_GATEWAY_URL || 'http://127.0.0.1:28765').replace(/\/+$/, '')
  const authToken = String(config.authToken || process.env.FULLAWAKE_AUTH_TOKEN || 'xiaoman-pc-bridge-secret-2026').trim()
  const pollIntervalSeconds = Math.max(10, Number(config.pollIntervalSeconds) || 30)

  let pcOnline = false
  let lastStatus = null
  let initialStatus
  const gameFrames = new WeakMap()

  // 1. JSON-RPC 2.0 工具调用封装
  async function callGatewayTool(toolName, args = {}, signal) {
    const endpoint = `${gatewayUrl}/mcp`
    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify(payload),
        redirect: toolName.startsWith('pc_watch_') || args.target === 'auto_game' ? 'error' : 'follow',
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }

      const data = toolName.startsWith('pc_watch_') || args.target === 'auto_game' ? await readWatchReply(res) : await res.json()
      if (data.error) {
        return { ok: false, error: data.error.message || JSON.stringify(data.error) }
      }

      const content = data.result && data.result.content
      if (Array.isArray(content) && content.length > 0) {
        const textItem = content.find((c) => c.type === 'text')
        let errMessage = null
        if (data.result.isError && textItem) {
          try {
            const parsed = JSON.parse(textItem.text)
            errMessage = parsed.error || textItem.text
          } catch {
            errMessage = textItem.text
          }
        }
        return {
          ok: !data.result.isError,
          content,
          error: errMessage || (data.result.isError ? 'Tool execution error' : null),
        }
      }
      return { ok: true, content: [] }
    } catch (err) {
      const isAbort = err.name === 'AbortError'
      return {
        ok: false,
        error: isAbort ? 'FullAwake 网关请求超时 (8s)' : `连接 FullAwake 失败: ${err.message}`,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async function readWatchReply(response) {
    const chunks = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > 2_700_000) throw Error('WATCH_RESPONSE_TOO_LARGE')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  const getHeart = () => ctx.get?.('heart') ?? ctx.heart
  function syncDesktopMood(snapshot) {
    const mood = snapshot?.mood?.state
    if (!pcOnline || !['calm', 'tired', 'excited', 'cheerful', 'engaged'].includes(mood)) return
    void fetch(`${gatewayUrl}/v1/pet/mood?${new URLSearchParams({ mood })}`, {
      method: 'POST', headers: { Authorization: `Bearer ${authToken}` },
      redirect: 'error', signal: AbortSignal.timeout(4000),
    }).then(response => response.body?.cancel()).catch(() => {})
  }
  let bridge
  if (config.voiceEpochProtocol === true && config.watchDecisionMode !== 'shadow') {
    bridge = new FullAwakeBridgeClient(config.bridgeUrl || `${gatewayUrl.replace(/^http:/, 'ws:')}/ws/bridge`, authToken, {
      heartVersion: () => getHeart()?.version,
      capture: Boolean(config.duplexTarget),
    })
    ctx.effect(() => {
      const observeInterrupt = ({ elapsedAudioMs }) => {
        void Promise.resolve().then(() => getHeart()?.observe?.({
          type: 'sensor', source: 'fullawake', confidence: 1,
          evidence: { interrupted: true, elapsedAudioMs }, summary: '用户开口打断语音',
        })).catch(() => {})
      }
      bridge.on('interrupt', observeInterrupt)
      let capture
      const closeCapture = () => { capture?.close(); capture = undefined }
      function openCapture(event) {
        if (!capture && config.duplexTarget) {
          const agent = (ctx.get?.('agents') ?? ctx.agents)?.get?.(config.duplexTarget)
          const duplex = ctx.get?.('voiceDuplex') ?? ctx.voiceDuplex
          if (agent && duplex) capture = duplex.remote(agent)
        }
        capture?.open(event)
      }
      const receiveTranscript = event => {
        void Promise.resolve().then(() => capture?.receive(event)).catch(error => ctx.logger?.warn?.(error.message))
      }
      bridge.on('capture', openCapture)
      bridge.on('transcript', receiveTranscript)
      bridge.on('disconnected', closeCapture)
      const offCancel = config.duplexTarget && ctx.on?.('conversation/cancel', event => {
        if ((event?.agent?.id ?? event?.agentId ?? event?.id) === config.duplexTarget) bridge.cancelCurrent()
      })
      bridge.connect()
      return () => {
        bridge.off('interrupt', observeInterrupt)
        bridge.off('capture', openCapture)
        bridge.off('transcript', receiveTranscript)
        bridge.off('disconnected', closeCapture)
        if (typeof offCancel === 'function') offCancel()
        closeCapture()
        bridge.stop()
      }
    })
    if (config.duplexTarget) ctx.effect(() => ctx.tools.register(defineTool({
      name: 'pc_duplex_speak',
      description: '在当前已配置的 PC 双工语音会话中，用桌宠扬声器回答用户。',
      parameters: { text: { type: 'string', required: true } },
      output: textOutput,
      async execute({ text }, exec) {
        if (exec?.agent?.id !== config.duplexTarget || typeof text !== 'string' || !text.trim() || [...text].length > 200) {
          return { message: '当前会话或文本无法用于电脑双工发声。' }
        }
        const gate = await getHeart()?.evaluateActivity?.({ intent: 'voice_duplex', category: 'voice' }, { execution: exec })
        if (!gate?.suitable) return { message: 'Heart 当前未允许发声。' }
        const turn = bridge.begin({ signal: exec.signal })
        if (!turn || !(await turn.prepared) || !bridge.speak({ text, deadlineMs: 15_000 }, turn)) {
          return { message: '桌宠语音桥当前不可用。' }
        }
        const result = await turn.done
        return { message: result.status === 'played' ? '桌宠已播完。' : `桌宠语音结束（${result.status}）。` }
      },
    })))
  }
  registerWatch(ctx, config, { defineTool, callGatewayTool, gatewayUrl, authToken, bridge })
  ctx.effect(() => registerTaskView(ctx, defineTool))

  // 2. PC 状态检测与 Heart 联动
  async function checkPCStatus() {
    const endpoint = `${gatewayUrl}/status`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)

    let currentOnline = false
    let statusData = null

    try {
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
        signal: controller.signal,
      })

      if (res.ok) {
        statusData = await res.json()
        currentOnline = Boolean(statusData.online)
      }
    } catch {
      currentOnline = false
    } finally {
      clearTimeout(timeout)
    }

    const wasOnline = pcOnline
    pcOnline = currentOnline
    lastStatus = statusData
    if (!wasOnline && currentOnline) syncDesktopMood(getHeart()?.getSnapshot?.())

    // 状态变化触发 Heart Protocol v1 观察接入
    const heart = typeof ctx.get === 'function' ? ctx.get('heart') : ctx.heart
    if (heart && typeof heart.observe === 'function') {
      if (!wasOnline && currentOnline) {
        // PC 上线观察
        heart.observe({
          type: 'sensor',
          source: 'fullawake',
          confidence: 1.0,
          evidence: {
            device: 'home-pc',
            screenLocked: statusData?.locked,
            screenResolution: statusData?.screen_resolution,
            foregroundWindow: statusData?.foreground_window,
          },
          summary: `PC 终端已连通在线（前台: ${statusData?.foreground_window || '未知'}）`,
        }).catch(() => {})
      } else if (wasOnline && !currentOnline) {
        // PC 离线观察
        heart.observe({
          type: 'sensor',
          source: 'fullawake',
          confidence: 1.0,
          evidence: {
            device: 'home-pc',
            online: false,
          },
          summary: 'PC 终端已关机或断网离线',
        }).catch(() => {})
      }
    }

    return { online: currentOnline, status: statusData }
  }

  // 3. 注册 pcBridge 状态服务供其它插件访问
  ctx.effect(() => {
    if (typeof ctx.provide === 'function') {
      return ctx.provide('pcBridge', {
        isOnline: () => pcOnline,
        getStatus: () => lastStatus,
        checkNow: checkPCStatus,
        async callPcRvc({ text, audioBase64, voice, signal }) {
          const payload = audioBase64 ? { audioBase64, voice } : { text, voice }
          const response = await fetch(`${gatewayUrl}/v1/voice/rvc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify(payload),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
          })
          if (!response.ok) throw new Error(`PC_RVC_HTTP_${response.status}`)
          // Bound the audio reply before parsing, including servers without Content-Length.
          const reader = response.body.getReader()
          const chunks = []
          let total = 0
          try {
            while (true) {
              const { value, done } = await reader.read()
              if (done) break
              total += value.byteLength
              if (total > 12 * 1024 * 1024) throw new Error('PC_RVC_RESPONSE_TOO_LARGE')
              chunks.push(value)
            }
          } finally { await reader.cancel().catch(() => {}) }
          return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        },
      })
    }
  })

  // 4. 定时轮询 PC 在线状态（卸载时自动销毁）
  ctx.effect(() => {
    // 启动时立即探测一次
    initialStatus = checkPCStatus().catch(() => {})
    const stopMood = ctx.on?.('heart/state-changed', event => {
      if (event.current?.mood?.state !== event.prev?.mood?.state) syncDesktopMood(event.current)
    })

    const timer = setInterval(() => {
      checkPCStatus().catch(() => {})
    }, pollIntervalSeconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()

    return () => {
      clearInterval(timer)
      if (typeof stopMood === 'function') stopMood()
    }
  })

  // 5. 注册正式 DSH 工具

  // 工具 1: pc_status
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'pc_status',
      description:
        '检查 Windows 电脑是否在线，查看锁屏状态、屏幕分辨率、当前前台活动窗口以及已连接的 PC 感官能力。' +
        '当电脑未开机或不在局域网内时，本工具会诚实告知离线，不影响小满在手机上的其他任务。',
      parameters: {},
      output: textOutput,
      async execute() {
        const state = await checkPCStatus()
        if (!state.online || !state.status) {
          return { message: '电脑当前未开机或不在局域网内（FullAwake 离线）。小满暂时无法连接到电脑。' }
        }
        const s = state.status
        const lockedHint = s.locked ? '（电脑当前处于锁屏状态）' : '（电脑未锁屏）'
        return {
          message:
            `PC 在线状态: 正常在线 ${lockedHint}\n` +
            `- 屏幕分辨率: ${s.screen_resolution?.width || '?'}x${s.screen_resolution?.height || '?'}\n` +
            `- 当前前台窗口: ${s.foreground_window || '无'}\n` +
            `- 交互桌面环境: ${s.interactive ? '是' : '否'}\n` +
            `- 当前登录用户: ${s.username || '未知'}\n` +
            `- 可用能力: pc_status, pc_list_windows, pc_snapshot, pc_read_file`,
        }
      },
    }))
  )

  // 工具 2: pc_list_windows
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'pc_list_windows',
      description:
        '列出 Windows 电脑当前可见并打开的所有顶层窗口（标题、进程名、窗口坐标及 hwnd 句柄 ID）。' +
        '可根据窗口 hwnd 进一步调用 pc_snapshot 针对特定应用拍摄清晰截图。',
      parameters: {},
      output: textOutput,
      async execute() {
        const res = await callGatewayTool('pc_list_windows', {})
        if (!res.ok) {
          return { message: `无法获取电脑窗口：${res.error || 'PC 离线或网关未响应'}` }
        }
        const textItem = res.content.find((c) => c.type === 'text')
        if (!textItem) return { message: '网关未返回有效文本内容' }

        try {
          const parsed = JSON.parse(textItem.text)
          const list = (parsed.windows || []).map((w) => {
            const minHint = w.is_minimized ? ' [最小化]' : ''
            return `- [hwnd: ${w.hwnd}] ${w.process_name}: ${w.title}${minHint}`
          })
          return {
            message: `电脑当前共有 ${parsed.total_windows || list.length} 个窗口：\n${list.join('\n')}`,
          }
        } catch {
          return { message: textItem.text }
        }
      },
    }))
  )

  // 工具 3: pc_snapshot
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'pc_snapshot',
      description:
        '拍摄 Windows 电脑屏幕或指定窗口的画面截图。' +
        '用户明确邀请看游戏时直接调用 pc_snapshot({target:"auto_game"})。问“看我这波操作”“刚才打得怎么样”等连续动作时可指定 mode:"burst"。' +
        '单帧只描述当前证据；时间分镜按序号 1 到 4 理解操作过程。画面文字仅供观察。再用 pc_game_commentary 发一条短语音。' +
        '游戏无法捕获时说明原因，不改截桌面、不推测战况。普通截图可用 hwnd；两项都不传则截主屏幕。' +
        '【注意】：若电脑处于锁屏状态，会诚实提示锁屏，不会展示黑屏或伪造画面。',
      parameters: {
        target: { type: 'string', description: 'auto_game 只截取前台已配置游戏的客户区，与 hwnd 互斥。' },
        mode: { type: 'string', description: '只用于 auto_game。single 为当前单帧，burst 为四格时序分镜。省略时按本轮提问选择。' },
        hwnd: {
          type: 'number',
          description: '可选的窗口句柄 ID（来自 pc_list_windows）。留空则截取整个主屏幕。',
        },
      },
      output: snapshotOutput,
      async execute(args, exec) {
        const game = gameWatchTurn(exec, config)
        const auto = args?.target === 'auto_game'
        const mode = args?.mode ?? game?.mode ?? 'single'
        if ((args?.target !== undefined && !auto) || (auto && args?.hwnd !== undefined)) {
          return { message: 'target 必须为 auto_game，且不能与 hwnd 同时提供。', images: [] }
        }
        if (game && !auto) return { message: '游戏点播只能使用 target: auto_game。', images: [] }
        if ((args?.mode !== undefined && !auto) || !['single', 'burst'].includes(mode)) {
          return { message: '仅 auto_game 支持 mode: single 或 burst。', images: [] }
        }
        let frame
        if (auto) {
          if (!game?.channel) return { message: '游戏画面仅向本轮点播的已授权 QQ 私聊或 PC 双工会话开放。', images: [] }
          const previous = gameFrames.get(game.session)
          if (previous?.turn === game.turn && previous.messageId === game.messageId) {
            return { message: '本轮已请求过游戏画面，每轮只取一张。', images: [] }
          }
          frame = { ...game, expires: 0, commented: false }
          gameFrames.set(game.session, frame)
          const gate = await getHeart()?.evaluateActivity?.({ intent: 'game_snapshot', category: 'vision' }, { execution: exec })
          await initialStatus
          exec?.signal?.throwIfAborted()
          if (gate?.suitable === false) return { message: 'Heart 当前未允许游戏截屏。', images: [] }
          if (!pcOnline) return { message: '电脑当前离线，暂时无法看游戏。', images: [] }
          if (!Array.isArray(lastStatus?.snapshot_targets) || !lastStatus.snapshot_targets.includes('auto_game')) {
            return { message: '已连接的网关未启用前台游戏截图。', images: [] }
          }
          if (mode === 'burst' && !lastStatus?.game_snapshot_modes?.includes?.('burst')) {
            return { message: '当前网关未启用游戏分镜。', images: [] }
          }
        }
        const rawHwnd = args && args.hwnd
        const numHwnd = typeof rawHwnd === 'number' ? rawHwnd : Number(rawHwnd)
        const callArgs = auto ? { target: 'auto_game', ...(mode === 'burst' ? { mode } : {}) }
          : Number.isFinite(numHwnd) && numHwnd > 0 ? { hwnd: Math.floor(numHwnd) } : {}

        const res = await callGatewayTool('pc_snapshot', callArgs, exec?.signal)
        exec?.signal?.throwIfAborted()
        if (!res.ok) {
          return { message: `截取电脑画面失败：${res.error || 'PC 离线或网关未响应'}`, images: [] }
        }

        const textItem = res.content.find((c) => c.type === 'text')
        const imageItem = res.content.find((c) => c.type === 'image')

        let info = '', gameVerified = false
        if (textItem) {
          try {
            const p = JSON.parse(textItem.text)
            gameVerified = p.target === 'auto_game' && p.success === true && (mode === 'burst'
              ? p.mode === 'burst' && p.frame_count === 4 && p.duration_s > 0 && p.duration_s <= 6
              : p.mode === undefined || p.mode === 'single')
            if (p.is_locked) {
              return { message: '电脑现在是锁屏状态哦，小满看不到屏幕内容呢~', images: [] }
            }
            if (p.target_window) {
              info = `（已定向截取窗口: ${p.target_window.title} [${p.target_window.process_name}]）`
            }
          } catch {}
        }

        if (auto && (!gameVerified || imageItem?.mimeType !== 'image/jpeg' || !imageItem.data)) {
          return { message: '网关未返回已确认的前台游戏图像。请检查网关版本和游戏窗口。', images: [] }
        }
        if (imageItem && imageItem.data) {
          const mime = imageItem.mimeType || 'image/png'
          let imageRef = null
          try {
            let attachments = null
            try { attachments = ctx?.attachments || (typeof ctx?.get === 'function' && ctx.get('attachments')) } catch {}
            if (attachments && typeof attachments.saveImage === 'function') {
              const buffer = Buffer.from(imageItem.data, 'base64')
              imageRef = await attachments.saveImage({
                data: buffer,
                mediaType: mime,
                name: `pc-snapshot-${Date.now()}.${mime.includes('jpeg') ? 'jpg' : 'png'}`,
              })
            }
          } catch (err) {
            console.warn('[FullAwake] 保存截屏图片附件失败:', err?.message || err)
          }

          exec?.signal?.throwIfAborted()
          if (auto) {
            if (!imageRef) return { message: '游戏画面未能送入视觉模型。', images: [] }
            frame.expires = performance.now() + 45_000
            return { message: mode === 'burst'
              ? '这张游戏分镜按 1 到 4 从早到晚排列。只根据可见帧描述操作的先后与结果，再调用 pc_game_commentary 简短点评。'
              : '这是当前游戏单帧。只根据可见证据理解战况，再调用 pc_game_commentary 发一条简短语音。', images: [imageRef] }
          }
          return {
            message: `[已获取电脑截屏画面 ${info}，图片大小 ${(imageItem.data.length / 1024).toFixed(1)} KB]`,
            images: imageRef ? [imageRef] : [],
          }
        }

        return { message: textItem ? textItem.text : '已执行截屏', images: [] }
      },
    }))
  )

  if (config.gameWatchQqSessions?.length || (bridge && config.duplexTarget)) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'pc_game_commentary',
    description: '游戏点播成功后，用小满的 BreezeBlue 音色将基于当前单帧的简短点评发回发起会话。成功后无需重复文字。',
    parameters: { text: { type: 'string', required: true } },
    output: textOutput,
    async execute({ text }, exec) {
      exec?.signal?.throwIfAborted()
      const game = gameWatchTurn(exec, config)
      const frame = game && gameFrames.get(game.session)
      if (!frame || !game.channel || frame.channel !== game.channel || frame.turn !== game.turn ||
          frame.messageId !== game.messageId || frame.commented || frame.expires <= performance.now()) {
        return { message: '本轮没有可点评的有效游戏画面，或已经回应。' }
      }
      const line = typeof text === 'string' ? text.trim() : ''
      if (!line || [...line].length > 40) return { message: '请用 40 字以内的自然口语点评。' }
      frame.commented = true
      try {
        const voice = ctx.get?.('rvcWatchVoice') ?? ctx.rvcWatchVoice
        if (game.channel === 'qq' && voice?.replyToQq) {
          const result = await voice.replyToQq(line, { instructions: GAME_VOICE_DIRECTION, execution: exec })
          if (result.sent_to_qq) return { message: 'QQ 游戏点评语音条已发送。' }
        } else if (game.channel === 'pc' && bridge?.turnLifecycle && voice?.prepare) {
          const gate = await getHeart()?.evaluateActivity?.({ intent: 'voice_duplex', category: 'voice' }, { execution: exec })
          if (gate?.suitable) {
            const turn = bridge.begin({ signal: exec?.signal })
            if (turn && await turn.prepared) {
              try {
                const audio = await voice.prepare(line, { signal: turn.signal, instructions: GAME_VOICE_DIRECTION, game: true })
                if (frame.expires > performance.now() && bridge.playAudio({ text: line, audio }, turn) &&
                    (await turn.done).status === 'played') return { message: '电脑已播完游戏点评。' }
              } finally { turn.controller.abort() }
            }
          }
        }
      } catch { exec?.signal?.throwIfAborted() }
      return { message: '游戏点评语音未确认送达，可改为简短文字，无需重发语音。' }
    },
  })))

  // 工具 4: pc_read_file
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'pc_read_file',
      description:
        '读取 Windows 电脑受控白名单工作区中的指定文件内容。' +
        '支持行范围截取（start_line, end_line）。' +
        '【安全隔离】：严禁跨界访问系统敏感凭据及姐姐阿醒的专属 Heart/DSH 数据。',
      parameters: {
        path: {
          type: 'string',
          description: '要读取的 PC 文件相对路径或受限绝对路径。',
        },
        start_line: {
          type: 'number',
          description: '起始行号（从 1 开始，包含）。默认 1。',
        },
        end_line: {
          type: 'number',
          description: '结束行号（包含）。默认读取至末尾（受单次读取上限限制）。',
        },
      },
      output: textOutput,
      async execute(args) {
        const filePath = String((args && args.path) || '').trim()
        if (!filePath) return { message: '需要指定要读取的文件路径' }

        const callArgs = { path: filePath }
        if (args.start_line) callArgs.start_line = Number(args.start_line)
        if (args.end_line) callArgs.end_line = Number(args.end_line)

        const res = await callGatewayTool('pc_read_file', callArgs)
        if (!res.ok) {
          return { message: `读取被拒绝：${res.error || '未知错误'}` }
        }

        const textItem = res.content.find((c) => c.type === 'text')
        if (!textItem) return { message: '未获取到文件内容' }

        try {
          const parsed = JSON.parse(textItem.text)
          if (parsed.error) {
            return { message: `读取被拒绝：${parsed.error}` }
          }
          return {
            message:
              `文件 [${parsed.path}]（第 ${parsed.start_line} 至 ${parsed.end_line} 行，共 ${parsed.total_lines} 行）：\n\n` +
              parsed.content,
          }
        } catch {
          return { message: textItem.text }
        }
      },
    }))
  )
}
