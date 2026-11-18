const gameRequest = /(?:看(?:看)?我.{0,8}(?:游戏|这一把|这把|这一波|这波|操作|打到哪)|(?:看|瞧)(?:看|瞧)?.{0,6}(?:游戏|战况|打到哪|这波操作)|我卡.{0,6}(?:看看画面|看一下)|刚才怎么(?:死|输)的)/u
const burstRequest = /(?:这一波|这波|上一波).{0,7}(?:操作|走位|打得|怎么打|团战)|(?:看看?|瞧瞧?).{0,5}(?:这一波|这波)(?:[，。！？!?\s]|$)|刚才.{0,8}(?:那下|打得|操作|怎么死|怎么输|怎么赢|怎么打|走位|帅不帅|发生了什么)/u
const stopRequest = /(?:不要|不用|别|停止|取消|暂不)(?:再|继续|帮我|给我|先|去)?(?:看|截|陪玩)|(?:如果|假如|举例|复述|引用|假装)/u
const turnBoundary = new Set(['turn/start', 'turn/end', 'session/end-seed'])

function gameUserTurn(exec, config) {
  const session = exec?.agent?.session
  const events = session?.snapshotEvents?.() ?? session?.events
  const callId = exec?.rootCallId ?? exec?.callId
  if (!callId || !Array.isArray(events) || exec.signal?.aborted) return null
  const start = events.findLastIndex(event => turnBoundary.has(event?.type))
  const turn = events[start]?.data?.turn
  if (events[start]?.type !== 'turn/start' || turn === undefined) return null
  const call = events.findLastIndex(event => event?.type === 'tool/call' && event.data?.callId === callId && event.data.turn === turn)
  if (call <= start) return null
  const message = events.slice(start + 1, call).findLast(event => event?.type === 'user/message')?.data
  if (message?.role !== 'user' || message.source?.kind !== 'user' || !message.id) return null
  const raw = message.content?.find(block => block?.type === 'text')?.text
  if (typeof raw !== 'string') return null
  const qq = message.source.qq
  if (qq && (!Number.isSafeInteger(qq.start) || !Number.isSafeInteger(qq.length) ||
      qq.start < 0 || qq.length < 1 || qq.start > raw.length - qq.length)) return null
  const text = (qq ? raw.slice(qq.start, qq.start + qq.length) : raw).trim()
  const normalize = id => typeof id === 'string' ? id.replace(/^session-/, '') : ''
  const id = normalize(session.id ?? session.header?.id ?? exec.agent.id)
  let channel = null
  if (qq?.channel === 'direct' && id &&
      config.gameWatchQqSessions?.some(value => normalize(value) === id)) channel = 'qq'
  if (!qq && config.voiceEpochProtocol === true && config.watchDecisionMode !== 'shadow' &&
      config.duplexTarget && exec.agent.id === config.duplexTarget) channel = 'pc'
  return { session, turn, messageId: message.id, channel, text }
}

export function gameWatchTurn(exec, config) {
  const user = gameUserTurn(exec, config)
  if (!user) return null
  const { text, ...turn } = user
  const burst = burstRequest.test(text)
  if ((!burst && !gameRequest.test(text)) || stopRequest.test(text)) return null
  const preference = /(?:静音|别出声|不要出声|别发语音|不要发语音|只(?:回|发)?文字)/u.test(text) ? 'text'
    : /(?:发|回|给我来)(?:我)?(?:一|个|段|条|句)*语音(?:条|消息)?/u.test(text) ? 'qq' : undefined
  return { ...turn, preference, mode: burst ? 'burst' : 'single' }
}

export function resolveDeliveryTarget({ channel, active, preference, muted }) {
  if (muted || preference === 'text') return 'text_only'
  if (preference === 'qq') return 'qq_voice'
  return channel === 'pc' || active ? 'pc_pet' : 'qq_voice'
}

export const GAME_VOICE_DIRECTION = '亲近清亮，带一点忍不住的轻笑，像坐在旁边陪打游戏。情况紧张时轻声鼓励，不取笑失误。'

const companionStop = /(?:不打了|不玩了|歇一会|休息(?:吧|了|一下)?|(?:别|结束|关闭|停止|取消)(?:再|继续)?(?:游戏陪伴|游戏陪看|陪我玩|陪我打|陪看))/u
const companionStart = /(?:开启游戏陪伴|开启游戏陪看|陪我(?:一起)?(?:玩.{0,7}游戏|打(?:几把|一把)|打.{0,6}游戏))/u
const hypothetical = /(?:如果|假如|举例|复述|引用|假装)/u
const forbiddenStart = /(?:别|不用|不要|停止|关闭|取消|静音|只(?:发|回)?文字)/u
const laterStop = /(?:(?:不要|不用|别)(?:急着|先)?休息|(?:打完|玩完|等).{0,12}(?:再|就|才).{0,4}(?:休息|不打))/u

const reaction = Object.freeze({
  death: '缓一缓，我陪你等复活。',
  recall: '回到家啦，慢慢补给。',
  win: '赢啦，这把辛苦你啦！',
  loss: '这把辛苦啦，我还在呢。',
})

export function registerGameCompanion(ctx, config, { bridge, defineTool, output, readyForWatch }) {
  if (config.gameWatchCompanion !== true || config.watchDecisionMode === 'shadow') return
  let watch = null
  let starting = null
  let stopping = false
  const service = name => ctx.get?.(name) ?? ctx[name]
  const clear = () => {
    const previous = watch
    watch = null
    previous?.controller.abort('game_watch_ended')
  }
  const ended = ({ watchId }) => { if (watch?.id === watchId) clear() }
  const onEvent = async ({ watchId, eventId, kind, outcome, remainingMs }) => {
    const current = watch
    const line = reaction[kind === 'victory' ? outcome : kind]
    if (!line || !current || current.id !== watchId || current.busy || current.latest === eventId || !bridge.breezeDirect) return
    const expires = performance.now() + remainingMs
    const fresh = () => watch === current && !current.controller.signal.aborted && performance.now() < expires
    current.latest = eventId
    current.busy = true
    const heart = service('heart')
    let reservation
    let turn
    try {
      // A confirmed semantic transition is a high-interest cue. No pixels leave the PC.
      const gate = await heart?.evaluateActivity?.({ intent: 'game_companion', category: 'game' })
      if (!fresh() || gate?.suitable !== true || heart.getSnapshot?.()?.presence?.status === 'asleep') return
      const decision = (service('agency') ?? heart.agency)?.evaluate?.({ active: true, sceneChange: 0.85, mode: 'game-watch' })
      if (decision?.action !== 'SPEAK' || !fresh() || !heart.commitQuota || !heart.rollbackQuota) return
      const quota = heart.reserveAutonomousQuota?.('game')
      if (quota?.ok !== true || !quota.reservationId) return
      reservation = quota.reservationId
      turn = bridge.begin({ signal: current.controller.signal, gameEventId: eventId })
      if (!turn || !await turn.prepared || !fresh()) return
      const instructions = service('rvcWatchVoice')?.gameInstructions?.(line) ?? GAME_VOICE_DIRECTION
      const deadlineMs = Math.floor(expires - performance.now())
      if (deadlineMs < 1 || !bridge.speak({ text: line, instructions, voiceProfile: 'breezeblue', pitchShift: 0, deadlineMs }, turn)) return
      if ((await turn.done).status !== 'played') return
      if (heart.commitQuota(reservation)) reservation = null
      await heart.observe?.({ type: 'audio', source: 'game_companion', confidence: 1,
        evidence: { scene: kind, outcome, delivery: 'pc_pet', textLength: [...line].length },
        summary: '游戏陪看安全窗口短句已播完', timestamp: new Date().toISOString() })
    } finally {
      turn?.controller.abort()
      current.busy = false
      if (reservation) heart.rollbackQuota(reservation)
    }
  }
  const receive = event => { void onEvent(event).catch(() => ctx.logger?.warn?.('[FullAwake] 游戏陪看短句未完成')) }
  bridge.on('game-watch-event', receive)
  bridge.on('game-watch-ended', ended)
  bridge.on('disconnected', clear)
  const unregister = ctx.tools.register(defineTool({
    name: 'pc_game_watch',
    description: '用户明确说“小满来陪我玩会儿游戏”时启动前台游戏陪看，说“不打了”或“休息”时结束。仅本人 QQ 私聊或已绑定 PC 语音可用。单次看画面仍使用 pc_snapshot。',
    parameters: { action: { type: 'string', enum: ['start', 'stop'], required: true } },
    output,
    async execute({ action }, exec) {
      const user = gameUserTurn(exec, config)
      if (!user?.channel || hypothetical.test(user.text) || (action === 'start'
        ? !companionStart.test(user.text) || companionStop.test(user.text) || forbiddenStart.test(user.text)
        : action !== 'stop' || !companionStop.test(user.text) || laterStop.test(user.text))) {
        return { message: '请在本人私聊或绑定的电脑语音中明确开启或结束游戏陪看。' }
      }
      if (action === 'stop') {
        starting?.abort('game_watch_stopped')
        clear()
        if (!stopping) {
          stopping = true
          try { await bridge.watchGame('stop') } finally { stopping = false }
        }
        return { message: '游戏陪看已结束。' }
      }
      if (watch) return { message: '游戏陪看已开启。' }
      if (starting || stopping) return { message: '正在处理上一条游戏陪看指令。' }
      starting = new AbortController()
      const signal = exec?.signal ? AbortSignal.any([exec.signal, starting.signal]) : starting.signal
      try {
        if (!await readyForWatch()) return { message: '电脑尚未就绪，请检查连接、游戏配置与 BreezeBlue。' }
        const result = await bridge.watchGame('start', { signal })
        if (signal.aborted || result?.status !== 'started') return { message: '当前前台游戏无法开启陪看。' }
        watch = { id: result.watchId, controller: new AbortController(), busy: false, latest: null }
        return { message: '游戏陪看已开启。我会在安全窗口轻声陪你。' }
      } finally { starting = null }
    },
  }))
  return () => {
    const active = watch
    starting?.abort('game_watch_unloaded')
    clear()
    if (active) void bridge.watchGame('stop')
    bridge.off('game-watch-event', receive)
    bridge.off('game-watch-ended', ended)
    bridge.off('disconnected', clear)
    if (typeof unregister === 'function') unregister()
  }
}
