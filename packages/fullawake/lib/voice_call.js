function callCommand(exec, config) {
  const session = exec?.agent?.session
  const events = session?.snapshotEvents?.() ?? session?.events
  const callId = exec?.rootCallId ?? exec?.callId
  if (!Array.isArray(events) || !callId || exec.signal?.aborted) return null
  const boundary = events.findLastIndex(event => ['turn/start', 'turn/end', 'session/end-seed'].includes(event?.type))
  if (events[boundary]?.type !== 'turn/start') return null
  const call = events.findLastIndex(event => event.type === 'tool/call' && event.data?.callId === callId &&
    event.data?.turn === events[boundary].data?.turn)
  if (call <= boundary) return null
  const message = events.slice(boundary + 1, call).findLast(event => event.type === 'user/message')?.data
  if (message?.role !== 'user' || message.source?.kind !== 'user') return null
  const block = message.content?.[0]
  if (block?.type !== 'text' || typeof block.text !== 'string') return null
  const qq = message.source.qq
  if (!qq && (!config.duplexTarget || exec.agent.id === config.duplexTarget)) return { text: block.text, channel: 'direct' }
  const normalize = id => typeof id === 'string' ? id.replace(/^session-/, '') : ''
  const id = normalize(session.id ?? session.header?.id ?? exec.agent.id)
  const sessionAllowed = !config.duplexQqSessions?.length || config.duplexQqSessions.some(value => normalize(value) === id)
  if (qq?.channel !== 'direct' || !sessionAllowed ||
      typeof qq.speaker !== 'string' || !Number.isSafeInteger(qq.start) || !Number.isSafeInteger(qq.length) ||
      qq.start < 0 || qq.length <= 0 || qq.start > block.text.length - qq.length) return null
  return { text: block.text.slice(qq.start, qq.start + qq.length), channel: 'direct',
    speaker: qq.speakerId || qq.speaker, targetId: qq.targetId }
}

export function registerVoiceCall(ctx, config, {
  bridge, defineTool, output, readyForCall, speak, canSpeak = () => false, replyRoute = {}, resolveTarget,
}) {
  const service = name => {
    try { return ctx.get?.(name) ?? ctx?.[name] } catch { return null }
  }
  let capture = null
  let starting = null
  let handoffError = false
  let pending = null
  let turn = null
  let playback = null
  const revoke = (cancelPlayback = true) => {
    pending = null
    if (turn) turn.revoked = true
    if (cancelPlayback) playback?.abort()
  }
  replyRoute.matches = (id, number) => number === -1 || (turn?.voice === true &&
    [turn.agent?.id, turn.session?.id, turn.session?.header?.id].includes(id) && turn.number === number)
  const close = reason => {
    const previous = capture
    capture = null
    revoke()
    bridge.cancelCurrent()
    try { previous?.close(reason) } catch {
      handoffError = true
      ctx.logger?.warn?.('[FullAwake] 通话已结束，记忆接力写入失败')
    }
  }
  let captureEpoch = -1
  const onCapture = event => {
    if (capture && event.audio_epoch > captureEpoch) {
      captureEpoch = event.audio_epoch
      // The PC revokes its own lease and then reports elapsedAudioMs asynchronously.
      revoke(false)
    }
    capture?.open(event)
  }
  const offEvents = ctx.on?.('session/event', (session, event) => {
    if (event.type === 'turn/start' && session === turn?.session) turn = null
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      if (turn?.session === session) {
        turn.revoked = true
        turn.voice = false
      }
      if (session !== pending?.agent.session || event.data?.id !== pending.id) return
      const events = session.snapshotEvents?.() ?? session.events
      turn = { ...pending, session, number: events?.findLast(item => item.type === 'turn/start')?.data?.turn,
        voice: canSpeak(), spoken: false, text: '' }
      pending = null
    }
    if (session !== turn?.session || turn.revoked || !turn.voice) return
    if (event.type === 'tool/call' && event.data?.name === 'pc_duplex_speak') turn.spoken = true
    if (event.type === 'assistant/message') {
      const message = event.data?.message ?? event.data
      turn.text = !event.data?.interrupted && Array.isArray(message?.content) && message.content.every(block => block.type !== 'tool-call')
        ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
        : ''
    }
    if (event.type !== 'turn/end' || (event.data?.reason && event.data.reason.kind !== 'completed') || turn.spoken || !turn.text) return
    turn.spoken = true
    const owner = turn
    const controller = playback = new AbortController()
    // Stay off the host turn's execution path. Playback can be interrupted after turn/end.
    void Promise.resolve().then(async () => {
      const limit = bridge.breezeDirect ? 120 : 200
      const characters = [...owner.text]
      const canSend = () => !owner.revoked && !controller.signal.aborted
      for (let offset = 0; offset < characters.length && canSend(); offset += limit) {
        const result = await speak(characters.slice(offset, offset + limit).join(''), {
          agent: owner.agent, signal: controller.signal, canSend,
        })
        if (result?.status !== 'played') break
      }
    }).catch(() => ctx.logger?.warn?.('[FullAwake] 通话直出播报失败')).finally(() => {
      if (playback === controller) playback = null
    })
  }, { global: true })
  const offCancel = ctx.on?.('conversation/cancel', event => {
    if ((event?.agent?.id ?? event?.agentId ?? event?.id) === (pending?.agent ?? turn?.agent)?.id) revoke()
  })
  const onTranscript = event => {
    const receiver = capture
    void Promise.resolve().then(async () => {
      if ((!receiver || await receiver.receive(event) === false) && event.is_final) {
        ctx.logger?.warn?.('[FullAwake] 通话转写未投递 ' + (receiver ? '回合已失效' : '通话未开启'))
      }
    }).catch(() => {
      ctx.logger?.warn?.('[FullAwake] 通话定稿未完成')
    })
  }
  const disconnected = () => { starting?.abort(); close('disconnected') }
  bridge.on('capture', onCapture)
  bridge.on('transcript', onTranscript)
  bridge.on('disconnected', disconnected)
  const onDesktopCall = ({ requestId, enabled }) => {
    void (async () => {
      const target = config.duplexTarget
      const agent = (typeof resolveTarget === 'function' ? resolveTarget() : null) ?? (target && service('agents')?.get?.(target))
      if (enabled && !agent) {
        bridge.replyDesktop('call', requestId, Boolean(capture), false, '未找到活跃私聊会话，请先在私聊给小满发一句话或点同步会话。')
        return
      }
      const qq = agent && service('qqbotMediaSender')?.resolveTargetForSession?.(agent.session?.id ?? agent.session?.header?.id ?? agent.id)
      const identity = qq?.scope === 'c2c' ? { targetId: qq.targetId, speaker: qq.targetId } : {}
      const res = await toggle(enabled, { agent, signal: AbortSignal.timeout(1750), pcInitiated: true }, { channel: 'direct', ...identity })
      const ok = Boolean(capture) === enabled && !starting
      bridge.replyDesktop('call', requestId, Boolean(capture) && !starting, ok, ok ? '' : (res?.message || '开启通话失败'))
    })().catch(err => bridge.replyDesktop('call', requestId, Boolean(capture), false, err?.message || '手机端异常'))
  }
  bridge.on('pc-call-request', onDesktopCall)
  const unregister = ctx.tools.register(defineTool({
    name: 'voice_call_toggle',
    description: '明确请求连麦时开启，明确请求挂断时关闭。需电脑麦克风和本地 VAD。连麦直接回复即可自动播报。',
    parameters: { enabled: { type: 'boolean', required: true } },
    output,
    async execute({ enabled }, exec) {
      const user = callCommand(exec, config)
      const command = enabled ? /(?:开启|开始)(?:语音)?(?:通话|连麦)|(?:来|一起)连麦|打个电话/u
        : /先挂(?:了|啦)|结束通话|挂断|断开连接|关闭连麦|关闭通话|哥哥去忙了/u
      if (!user || typeof enabled !== 'boolean' || !command.test(user.text) ||
          /如果|假如|引用|复述|(?:不要|不用|别).{0,6}(?:开启|开始|挂断|结束|断开|关闭|连麦|打.{0,2}电话|通话)/u.test(user.text)) {
        return { message: '请在本人已授权的私聊或绑定电脑会话中明确开启或结束通话。' }
      }
      return toggle(enabled, exec, user)
    },
  }))
  async function toggle(enabled, exec, user) {
      if (!enabled) {
        starting?.abort()
        close('hangup')
        await bridge.setCallActive(false)
        return { message: handoffError ? '通话已结束，话题接力写入失败。' : '通话已结束，回到文字聊天。' }
      }
      if (capture) return { message: '通话已开启。' }
      if (starting) return { message: '正在开启通话。' }
      starting = new AbortController()
      const signal = exec.signal ? AbortSignal.any([starting.signal, exec.signal]) : starting.signal
      try {
        if (!exec?.pcInitiated) {
          const gate = await service('heart')?.evaluateActivity?.({ intent: 'voice_call', category: 'voice' }, { execution: exec })
          if (gate?.suitable !== true) return { message: 'Heart 当前未允许开启通话。' }
        }
        if (!await readyForCall() || signal.aborted || !bridge.turnLifecycle) return { message: '电脑通话链路尚未就绪。' }
        const agent = service('agents')?.get?.(config.duplexTarget || exec?.agent?.id) ?? exec?.agent
        const duplex = service('voiceDuplex')
        if (!agent || !duplex?.startCall || !service('memory')?.handoff?.saveCall) return { message: '语音会话或记忆接力服务尚未就绪。' }
        handoffError = false
        captureEpoch = -1
        const agentId = agent.id
        const resolveAgent = () => service('agents')?.get?.(agentId) ?? resolveTarget?.()
        const current = capture = duplex.startCall(agent, { resolveAgent, channel: user.channel, speaker: user.speaker, targetId: user.targetId,
          onInput(message, liveAgent = agent) {
            const block = message.content[0]
            if (!block?.text?.startsWith('[Voice message]')) return
            pending = { agent: liveAgent, id: message.id }
          },
          onEnd() {
            if (capture !== current) return
            capture = null
            revoke()
            bridge.cancelCurrent()
            void bridge.setCallActive(false)
          },
        })
        const result = await bridge.setCallActive(true, { signal })
        if (result?.active !== true || signal.aborted || capture !== current) {
          close('unavailable')
          return { message: '电脑通话未能开启。' }
        }
        return { message: '通话已开启。直接回复即可在电脑播报，只有执行其他工具时需要插播才调用 pc_duplex_speak。结束时说“先挂了”。' }
      } finally { starting = null }
  }
  return () => {
    starting?.abort()
    close('unloaded')
    bridge.off('capture', onCapture)
    bridge.off('transcript', onTranscript)
    bridge.off('disconnected', disconnected)
    bridge.off('pc-call-request', onDesktopCall)
    if (typeof offEvents === 'function') offEvents()
    if (typeof offCancel === 'function') offCancel()
    if (typeof unregister === 'function') unregister()
  }
}
