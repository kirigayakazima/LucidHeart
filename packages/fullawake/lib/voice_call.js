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
  return { text: block.text.slice(qq.start, qq.start + qq.length), channel: 'direct', speaker: qq.speaker }
}

export function registerVoiceCall(ctx, config, { bridge, defineTool, output, readyForCall }) {
  const service = name => ctx.get?.(name) ?? ctx[name]
  let capture = null
  let starting = null
  let handoffError = false
  const close = reason => {
    const previous = capture
    capture = null
    bridge.cancelCurrent()
    try { previous?.close(reason) } catch {
      handoffError = true
      ctx.logger?.warn?.('[FullAwake] 通话已结束，记忆接力写入失败')
    }
  }
  const onCapture = event => capture?.open(event)
  const onTranscript = event => {
    void Promise.resolve().then(() => capture?.receive(event)).catch(() => {
      ctx.logger?.warn?.('[FullAwake] 通话定稿未完成')
    })
  }
  const disconnected = () => { starting?.abort(); close('disconnected') }
  bridge.on('capture', onCapture)
  bridge.on('transcript', onTranscript)
  bridge.on('disconnected', disconnected)
  const unregister = ctx.tools.register(defineTool({
    name: 'voice_call_toggle',
    description: '用户明确说“开启通话/连麦”时 enabled=true，明确说“先挂了/结束通话”时 enabled=false。电脑须已开启麦克风和本地 VAD。挂断后将最近三轮话题交接到下一次本人私聊。',
    parameters: { enabled: { type: 'boolean', required: true } },
    output,
    async execute({ enabled }, exec) {
      const user = callCommand(exec, config)
      const command = enabled ? /(?:开启|开始)(?:语音)?(?:通话|连麦)|(?:来|一起)连麦|打个电话/u
        : /先挂(?:了|啦)|结束通话|挂断|哥哥去忙了/u
      if (!user || typeof enabled !== 'boolean' || !command.test(user.text) ||
          /如果|假如|引用|复述|(?:不要|不用|别).{0,6}(?:开启|开始|挂断|结束|连麦|打.{0,2}电话|通话)/u.test(user.text)) {
        return { message: '请在本人已授权的私聊或绑定电脑会话中明确开启或结束通话。' }
      }
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
        const gate = await service('heart')?.evaluateActivity?.({ intent: 'voice_call', category: 'voice' }, { execution: exec })
        if (gate?.suitable !== true) return { message: 'Heart 当前未允许开启通话。' }
        if (!await readyForCall() || signal.aborted || !bridge.turnLifecycle) return { message: '电脑通话链路尚未就绪。' }
        const agent = service('agents')?.get?.(config.duplexTarget || exec?.agent?.id) ?? exec?.agent
        const duplex = service('voiceDuplex')
        if (!agent || !duplex?.startCall || !service('memory')?.handoff?.saveCall) return { message: '语音会话或记忆接力服务尚未就绪。' }
        handoffError = false
        const current = capture = duplex.startCall(agent, { channel: user.channel, speaker: user.speaker,
          onEnd() {
            if (capture !== current) return
            capture = null
            bridge.cancelCurrent()
            void bridge.setCallActive(false)
          },
        })
        const result = await bridge.setCallActive(true, { signal })
        if (result?.active !== true || signal.aborted || capture !== current) {
          close('unavailable')
          return { message: '电脑通话未能开启。' }
        }
        return { message: '通话已开启，可以直接说话。用 pc_duplex_speak 从电脑回应，结束时说“先挂了”。' }
      } finally { starting = null }
    },
  }))
  return () => {
    starting?.abort()
    close('unloaded')
    bridge.off('capture', onCapture)
    bridge.off('transcript', onTranscript)
    bridge.off('disconnected', disconnected)
    if (typeof unregister === 'function') unregister()
  }
}
