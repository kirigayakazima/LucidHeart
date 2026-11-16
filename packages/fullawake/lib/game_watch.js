const gameRequest = /(?:看(?:看)?我.{0,8}(?:游戏|这一把|这把|这一波|这波|操作|打到哪)|(?:看|瞧)(?:看|瞧)?.{0,6}(?:游戏|战况|打到哪|这波操作)|我卡.{0,6}(?:看看画面|看一下)|刚才怎么(?:死|输)的)/u
const burstRequest = /(?:这一波|这波|上一波).{0,7}(?:操作|走位|打得|怎么打|团战)|(?:看看?|瞧瞧?).{0,5}(?:这一波|这波)(?:[，。！？!?\s]|$)|刚才.{0,8}(?:那下|打得|操作|怎么死|怎么输|怎么赢|怎么打|走位|帅不帅|发生了什么)/u
const stopRequest = /(?:不要|不用|别|停止|取消|暂不).{0,6}(?:看|截|陪玩)|(?:如果|假如|举例|复述|引用|假装)/u
const turnBoundary = new Set(['turn/start', 'turn/end', 'session/end-seed'])

export function gameWatchTurn(exec, config) {
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
  const burst = burstRequest.test(text)
  if ((!burst && !gameRequest.test(text)) || stopRequest.test(text)) return null
  const normalize = id => typeof id === 'string' ? id.replace(/^session-/, '') : ''
  const id = normalize(session.id ?? session.header?.id ?? exec.agent.id)
  let channel = null
  if (qq?.channel === 'direct' && id &&
      config.gameWatchQqSessions?.some(value => normalize(value) === id)) channel = 'qq'
  if (!qq && config.voiceEpochProtocol === true && config.watchDecisionMode !== 'shadow' &&
      config.duplexTarget && exec.agent.id === config.duplexTarget) channel = 'pc'
  return { session, turn, messageId: message.id, channel, mode: burst ? 'burst' : 'single' }
}

export const GAME_VOICE_DIRECTION = '亲近清亮，带一点忍不住的轻笑，像坐在旁边陪打游戏。情况紧张时轻声鼓励，不取笑失误。'
