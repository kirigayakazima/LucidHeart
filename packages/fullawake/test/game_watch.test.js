import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { apply } from '../lib/index.js'
import { apply as applyRvc } from '../../rvc/lib/index.js'

const picture = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const speech = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000, 1)])
const fixtures = [
  { game: 'League of Legends.exe', request: '小满看我这一把', line: '蓝队正在打龙呀，河道口还有两个人。', channel: 'qq' },
  { game: 'VALORANT-Win64-Shipping.exe', request: '看我打到哪了', line: '炸弹已经安好啦，听着这个点位就行。', channel: 'pc' },
  { game: 'Hades.exe', request: '小满看我游戏', line: '刚进下一间房呢，这点血可得省着花呀。', channel: 'qq' },
]

function execution(text, channel, { id = 'owner', kind = 'user' } = {}) {
  const source = { kind, ...(channel !== 'pc' && { qq: { channel: channel === 'qq' ? 'direct' : channel,
    speaker: '已绑定的 QQ 昵称', start: 0, length: text.length } }) }
  const session = { id, events: [{ type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'message', role: 'user', content: [{ type: 'text', text }], source } }] }
  return { next(callId) {
    session.events.push({ type: 'tool/call', data: { turn: 1, callId } })
    return { agent: { id, session }, callId, signal: new AbortController().signal }
  } }
}

async function fixture(t, game, { oldGateway = false, missingMetadata = false, singleOnly = false,
  active = false, direct = false, muted = false, qqTarget = 'owner', qqScope = 'c2c',
  companion = false, decisionMode, playback = 'played' } = {}) {
  const calls = [], voices = [], played = [], sent = [], saved = [], observations = [], prepared = []
  const controls = [], cancelled = []
  const server = createServer(async (request, response) => {
    if (request.url === '/status') return response.end(JSON.stringify({ online: true,
      snapshot_targets: oldGateway ? [] : ['auto_game'], game_snapshot_modes: singleOnly ? ['single'] : ['single', 'burst'],
      game_watch_active: active, game_process: active ? game : null, game_watch_sessions: companion,
      snapshot_regions: oldGateway ? [] : ['full', 'left', 'right', 'center', 'minimap'] }))
    if (request.url.startsWith('/v1/pet/mood')) return response.writeHead(204).end()
    if (!['/mcp', '/breeze/voc_myarmcyqm2zv?output_format=mp3'].includes(request.url)) return response.writeHead(404).end()
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    if (request.url.startsWith('/breeze/')) {
      voices.push(payload)
      return response.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(speech)
    }
    calls.push(payload.params)
    const burst = payload.params.arguments.mode === 'burst' ? { mode: 'burst', frame_count: 4, duration_s: 3 } : {}
    const region = payload.params.arguments.region
    return response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { content: [
      { type: 'image', mimeType: 'image/jpeg', data: picture.toString('base64') },
      { type: 'text', text: JSON.stringify({ success: true, ...(missingMetadata ? {} : { target: 'auto_game', game_process: game, ...burst,
        ...(region && { region, snapshot_size: { width: 768, height: 500 } }) }) }) },
    ] } }))
  })
  const sockets = new WebSocketServer({ server, path: '/ws/bridge' })
  const ready = Promise.withResolvers()
  let push
  sockets.on('connection', socket => {
    let seq = 0
    socket.on('message', raw => {
      const { type, sessionId, connectionId, payload } = JSON.parse(raw)
      const send = (reply, body) => socket.send(JSON.stringify({ type: reply, sessionId, connectionId,
        protocol: 'lucid.voice/1', commandSeq: ++seq, payload: body }))
      const { epoch, utteranceId } = payload
      if (type === 'session.handshake') {
        push = send
        send('session.handshake_ack', { status: 'ready', initialEpoch: 100, vadSupported: true, turnLifecycle: true,
          ...(direct && { gameVoice: true }) })
        ready.resolve()
      } else if (type === 'audio.prepare') {
        prepared.push(payload)
        send('audio.prepared', { epoch, utteranceId })
      } else if (type === 'audio.play' || type === 'audio.speak') {
        played.push(payload)
        if (playback) send('audio.result', { epoch, utteranceId, status: playback })
      } else if (type === 'audio.cancel') {
        cancelled.push(payload)
      } else if (type === 'game.watch') {
        controls.push(payload.action)
        const start = payload.action === 'start'
        send('game.watch.status', { requestId: payload.requestId, status: start ? 'started' : 'stopped', watchId: start ? 'watch' : null })
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const root = await mkdtemp(path.join(tmpdir(), 'game-watch-'))
  const tools = new Map(), services = new Map(), dispose = []
  t.after(async () => {
    while (dispose.length) dispose.pop()()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise(resolve => sockets.close(resolve))
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await rm(root, { recursive: true, force: true })
  })
  const host = { tools: { register(tool) { tools.set(tool.name, tool) } }, on() {},
    get: key => services.get(key), provide: (key, value) => { services.set(key, value) },
    effect(fn) { const stop = fn(); if (typeof stop === 'function') dispose.push(stop) } }
  services.set('attachments', { async saveImage(value) { saved.push(value); return { id: 'game-frame', mediaType: 'image/jpeg' } } })
  services.set('heart', { version: '0.21.3', getSnapshot: () => ({ mood: { state: 'calm' } }),
    evaluateActivity: ({ category }) => ({ suitable: category !== 'voice' || !muted, origin: 'user_request' }),
    async observe(item) { observations.push(item) } })
  services.set('qqbotMediaSender', {
    resolveTargetForSession: id => id === 'owner' ? { scope: qqScope, targetId: 'owner-qq' } : undefined,
    async sendVoice(target, value) { sent.push({ target, value }); return { ok: true } },
  })
  apply(host, { gatewayUrl: base, gameWatchQqSessions: ['owner'], gameWatchQqTargetSession: qqTarget,
    voiceEpochProtocol: true, duplexTarget: 'pc-game', gameWatchCompanion: companion, watchDecisionMode: decisionMode })
  applyRvc(host, { breezeApiKey: 'fixture-only', breezeEndpoint: `${base}/breeze`, songsDir: root,
    saveDataset: true, datasetDir: path.join(root, 'dataset') })
  if (decisionMode !== 'shadow') await Promise.race([
    ready.promise, delay(4000, undefined, { ref: false }).then(() => assert.fail('Game bridge handshake timed out')),
  ])
  await setImmediate()
  return { tools, calls, voices, played, sent, saved, observations, prepared, controls, cancelled, heart: services.get('heart'),
    candidate(eventId, extra) { push('game.watch.event', { watchId: 'watch', eventId, kind: 'death', outcome: null, remainingMs: 2500, ...extra }) } }
}

async function until(predicate) {
  for (let tries = 0; tries < 100; tries++) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('Game watch side effect was not received')
}

for (const playback of ['played', 'discarded', null]) {
  test(`game companion settles quota after ${playback ?? 'explicit stop'}`, { timeout: 5000 }, async t => {
    const f = await fixture(t, fixtures[0].game, { companion: true, direct: true, playback })
    let suitable = false
    const quota = []
    Object.assign(f.heart, {
      evaluateActivity(request, context) {
        assert.equal(context, undefined)
        assert.deepEqual(request, { intent: 'game_companion', category: 'game' })
        return { suitable }
      },
      agency: { evaluate: () => ({ action: 'SPEAK' }) },
      reserveAutonomousQuota(category) { quota.push(['reserve', category]); return { ok: true, reservationId: 'held' } },
      commitQuota(id) { quota.push(['commit', id]); return true },
      rollbackQuota(id) { quota.push(['rollback', id]); return true },
    })
    const tool = f.tools.get('pc_game_watch')
    const start = (text, channel, options) => tool.execute({ action: 'start' }, execution(text, channel, options).next('watch-start'))
    await start('小满来陪我玩会儿游戏', 'group')
    await start('小满来陪我玩会儿游戏', 'qq', { id: 'someone-else' })
    await start('如果小满来陪我玩会儿游戏', 'qq')
    await start('小满陪我看游戏', 'qq')
    await start('小满来陪我玩会儿游戏', 'qq', { kind: 'schedule' })
    assert.deepEqual(f.controls, [])
    assert.match((await start('小满来陪我玩会儿游戏', 'qq')).message, /已开启/)
    await tool.execute({ action: 'stop' }, execution('小满，打完这把再休息', 'qq').next('later'))
    assert.deepEqual(f.controls, ['start'])
    f.candidate('gated')
    await delay(30)
    assert.deepEqual(quota, [])
    suitable = true
    f.candidate('candidate', { kind: 'victory', outcome: 'loss' })
    await until(() => f.played.length)
    f.candidate('candidate')
    assert.equal(f.prepared[0].gameEventId, 'candidate')
    assert.equal(f.played[0].voiceProfile, 'breezeblue')
    assert.equal(f.played[0].text, '这把辛苦啦，我还在呢。')
    assert.ok(f.played[0].deadlineMs <= 2500)
    await tool.execute({ action: 'stop' }, execution('小满，不打了', 'pc', { id: 'pc-game' }).next('watch-stop'))
    await until(() => quota.length === 2)
    if (playback === null) await until(() => f.cancelled.length === 1)
    f.candidate('after-stop')
    await delay(30)
    assert.deepEqual(quota, [['reserve', 'game'], [playback === 'played' ? 'commit' : 'rollback', 'held']])
    assert.equal(f.observations.filter(item => item.source === 'game_companion').length, playback === 'played' ? 1 : 0)
    assert.equal(f.played.length, 1)
    assert.deepEqual([f.calls, f.voices, f.sent, f.saved], [[], [], [], []])
    assert.deepEqual(f.controls, ['start', 'stop'])
  })
}

test('shadow cannot open an autonomous game companion', { timeout: 5000 }, async t => {
  const f = await fixture(t, fixtures[0].game, { companion: true, direct: true, decisionMode: 'shadow' })
  assert.equal(f.tools.has('pc_game_watch'), false)
  assert.deepEqual(f.controls, [])
})

test('game companion drops denied and expired events before reserving quota', { timeout: 5000 }, async t => {
  const f = await fixture(t, fixtures[0].game, { companion: true, direct: true })
  const gates = []
  const quotas = []
  let decisions = 0
  Object.assign(f.heart, {
    evaluateActivity() { const gate = Promise.withResolvers(); gates.push(gate); return gate.promise },
    agency: { evaluate() { decisions++; return { action: 'SILENCE' } } },
    reserveAutonomousQuota(category) { quotas.push(category) },
    commitQuota() {},
    rollbackQuota() {},
  })
  const exec = execution('小满来陪我玩会儿游戏', 'pc', { id: 'pc-game' }).next('start')
  assert.match((await f.tools.get('pc_game_watch').execute({ action: 'start' }, exec)).message, /已开启/)
  f.candidate('expired', { remainingMs: 10 })
  await until(() => gates.length === 1)
  await delay(20)
  gates[0].resolve({ suitable: true })
  await setImmediate()
  assert.equal(decisions, 0)
  f.candidate('muted')
  await until(() => gates.length === 2)
  gates[1].resolve({ suitable: true })
  await until(() => decisions === 1)
  assert.deepEqual([quotas, f.prepared, f.played], [[], [], []])
})

test('an authorized game view can zoom once, and a direct spatial request can start with a crop', { timeout: 5000 }, async t => {
  const f = await fixture(t, fixtures[0].game)
  const snapshot = f.tools.get('pc_snapshot')
  const turn = execution('小满看我这一把', 'qq')
  const first = await snapshot.execute({ target: 'auto_game' }, turn.next('full'))
  assert.equal(first.images.length, 1)
  assert.match(first.source_hash, /^[a-f0-9]{64}$/)
  const zoom = await snapshot.execute({ target: 'auto_game', region: 'left' }, turn.next('zoom'))
  assert.equal(zoom.images.length, 1)
  assert.deepEqual(f.calls.at(-1).arguments, { target: 'auto_game', region: 'left' })
  const repeated = await snapshot.execute({ target: 'auto_game', region: 'right' }, turn.next('again'))
  assert.deepEqual(repeated.images, [])
  assert.equal(f.calls.length, 2)
  const direction = execution('看小地图', 'qq')
  assert.equal((await snapshot.execute({ target: 'auto_game', region: 'minimap' }, direction.next('map'))).images.length, 1)
})

for (const { game, request, line, channel } of fixtures) {
  test(`${game} single frame becomes one BreezeBlue reply on ${channel}`, { timeout: 8000 }, async t => {
    const { tools, calls, voices, played, sent, saved } = await fixture(t, game)
    const turn = execution(request, channel, { id: channel === 'pc' ? 'pc-game' : 'owner' })
    const snap = tools.get('pc_snapshot'), comment = tools.get('pc_game_commentary')
    const args = { target: 'auto_game' }
    const view = await snap.execute(args, turn.next('snapshot'))
    const visual = snap.output.render(args, view).filter(block => block.type === 'image')
    assert.deepEqual(visual, [{ type: 'image', attachment: { id: 'game-frame', mediaType: 'image/jpeg' } }])
    assert.deepEqual(saved[0].data, picture)
    assert.deepEqual((await snap.execute(args, turn.next('repeat'))).images, [])
    assert.deepEqual(calls, [{ name: 'pc_snapshot', arguments: args }])
    // The vision model is represented by a fixed response after receiving the image block.
    const reply = await comment.execute({ text: line }, turn.next('respond'))
    assert.match(reply.message, channel === 'pc' ? /已播完/ : /已发送/)
    assert.match((await comment.execute({ text: line }, turn.next('again'))).message, /已经回应/)
    assert.equal(voices.length, 1)
    assert.equal(voices[0].text, line)
    assert.match(voices[0].instructions, /轻笑/)
    if (channel === 'pc') assert.deepEqual(Buffer.from(played[0].audioBase64, 'base64'), speech)
    else assert.equal(sent[0]?.target.targetId, 'owner-qq')
    assert.deepEqual([sent.length, played.length], channel === 'pc' ? [0, 1] : [1, 0])
  })
}

test('group, unbound peer and simulated messages cannot capture or comment. Older gateways cannot return a desktop frame as a game',
  { timeout: 8000 }, async t => {
    const { tools, calls, voices, saved } = await fixture(t, fixtures[0].game, { oldGateway: true })
    const args = { target: 'auto_game' }
    const req = fixtures[0].request
    const snap = tools.get('pc_snapshot'), comment = tools.get('pc_game_commentary')
    for (const turn of [execution(req, 'group'), execution(req, 'qq', { id: 'someone' }),
      execution(req, 'qq', { kind: 'schedule' }), execution('不要看我游戏', 'qq')]) {
      assert.deepEqual((await snap.execute(args, turn.next('snapshot'))).images, [])
      assert.match((await comment.execute({ text: '随口说一句' }, turn.next('speak'))).message, /没有可点评/)
    }
    assert.equal(calls.length, 0)
    const turn = execution(req, 'qq')
    assert.deepEqual((await snap.execute({}, turn.next('desktop'))).images, [])
    assert.match((await snap.execute(args, turn.next('old-gateway'))).message, /未启用前台游戏/)
    assert.equal(calls.length, 0)
    assert.deepEqual([voices.length, saved.length], [0, 0])
  })

test('a snapshot without positive target metadata never reaches vision', { timeout: 8000 }, async t => {
  const { tools, calls, saved } = await fixture(t, fixtures[0].game, { missingMetadata: true })
  const turn = execution(fixtures[0].request, 'qq')
  const result = await tools.get('pc_snapshot').execute({ target: 'auto_game' }, turn.next('capture'))
  assert.match(result.message, /未返回已确认/)
  assert.deepEqual(result.images, [])
  assert.equal(calls.length, 1)
  assert.equal(saved.length, 0)
})

for (const request of ['小满看我这波操作', '刚才打得怎么样', '看我刚才那下帅不帅']) {
  test(`dynamic request ${request} delivers one chronological image and one QQ voice reply`, async t => {
    const { tools, calls, sent, saved } = await fixture(t, fixtures[0].game)
    const turn = execution(request, 'qq')
    const target = { target: 'auto_game' }
    const tool = tools.get('pc_snapshot')
    const result = await tool.execute(target, turn.next('capture'))
    assert.match(result.message, /1 到 4 从早到晚/)
    assert.equal(tool.output.render(target, result).filter(block => block.type === 'image').length, 1)
    assert.equal(saved.length, 1)
    assert.deepEqual(calls, [{ name: 'pc_snapshot', arguments: { ...target, mode: 'burst' } }])
    const comment = tools.get('pc_game_commentary')
    assert.match((await comment.execute({ text: '先走位躲开了，后来还是被追上啦。' }, turn.next('reply'))).message, /已发送/)
    await comment.execute({ text: '重复点评' }, turn.next('retry'))
    assert.equal(sent.length, 1)
  })
}

test('burst is not substituted by a single frame on older gateways', async t => {
  const { tools, calls, saved } = await fixture(t, fixtures[0].game, { singleOnly: true })
  const turn = execution('小满看我这波操作', 'qq')
  const result = await tools.get('pc_snapshot').execute({ target: 'auto_game' }, turn.next('capture'))
  assert.match(result.message, /未启用游戏分镜/)
  assert.deepEqual([calls.length, saved.length], [0, 0])
})

test('an authorized turn can explicitly choose single for a dynamic question', async t => {
  const { tools, calls } = await fixture(t, fixtures[0].game)
  const turn = execution('看我刚才那下帅不帅', 'qq')
  const result = await tools.get('pc_snapshot').execute({ target: 'auto_game', mode: 'single' }, turn.next('capture'))
  assert.match(result.message, /当前游戏单帧/)
  assert.deepEqual(calls[0].arguments, { target: 'auto_game' })
})

for (const [channel, suffix, muted, expected] of [
  ['pc', '', false, 'pc_pet'], ['qq', '', false, 'pc_pet'],
  ['qq', '，发语音条', false, 'qq_voice'], ['pc', '，发语音条', false, 'qq_voice'],
  ['qq', '，只回文字', false, 'text_only'], ['pc', '，发语音条', true, 'text_only'],
]) {
  test(`game voice ${channel}${suffix} muted=${muted} routes to ${expected}`, async t => {
    const game = fixtures[2].game
    const { tools, voices, played, sent, observations, prepared } = await fixture(t, game, { active: true, direct: true, muted })
    const turn = execution(`小满看我游戏${suffix}`, channel, { id: channel === 'pc' ? 'pc-game' : 'owner' })
    const view = await tools.get('pc_snapshot').execute({ target: 'auto_game' }, turn.next('capture'))
    assert.equal(view.images.length, 1)
    const line = '这点血得省着用呀。'
    const result = await tools.get('pc_game_commentary').execute({ text: line }, turn.next('reply'))
    const logs = observations.filter(item => item.source === 'game_companion')
    if (expected === 'text_only') {
      assert.match(result.message, /文字/)
      assert.deepEqual([voices.length, played.length, sent.length, logs.length], [0, 0, 0, 0])
      return
    }
    if (expected === 'pc_pet') {
      assert.match(result.message, /已播完/)
      assert.equal(prepared[0].gameProcess, game)
      assert.equal(played[0].voiceProfile, 'breezeblue')
      assert.match(played[0].instructions, /轻笑/)
      assert(!Object.hasOwn(played[0], 'audioBase64'))
      assert.deepEqual([voices.length, played.length, sent.length], [0, 1, 0])
    } else {
      assert.match(result.message, /已发送/)
      assert.equal(sent[0].target.targetId, 'owner-qq')
      assert.deepEqual([voices.length, played.length, sent.length], [1, 0, 1])
    }
    assert.deepEqual(logs.map(item => item.evidence), [{ scene: 'game_commentary', delivery: expected,
      textLength: [...line].length, gameProcess: game }])
  })
}

test('a configured PC-to-QQ route refuses a group resolution before synthesis', async t => {
  const { tools, voices, played, sent } = await fixture(t, fixtures[2].game, { direct: true, qqScope: 'group' })
  const turn = execution('小满看我游戏，发语音条', 'pc', { id: 'pc-game' })
  await tools.get('pc_snapshot').execute({ target: 'auto_game' }, turn.next('capture'))
  const result = await tools.get('pc_game_commentary').execute({ text: '看见啦。' }, turn.next('reply'))
  assert.match(result.message, /未确认送达/)
  assert.deepEqual([voices.length, played.length, sent.length], [0, 0, 0])
})
