import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { detectHostPersona } from '../../qq-plus/lib/personas.js'
import { computeAcousticProfile, joinVoiceChunks } from '../../rvc/lib/acoustic.js'
import { createWake } from '../../heart-wake/lib/wake.js'
import { MemoryService } from '../../memory/lib/service.js'
import { registerWatch } from '../../fullawake/lib/watch.js'
import { startTwenty, twentyAction } from '../../companion/lib/activity/twenty_questions.js'
import { createCompanion } from '../../companion/lib/index.js'
import { loadScenarios, runReplay } from '../lib/benchmark/replay_runner.js'
import { signature } from '../lib/collaboration/sister_channel.js'
import { verifyEvidence } from '../lib/footprint/growth_footprint.js'
import { chatArgs, direct, fixture, group, noon, sandbox, secret } from './fixture.js'

const verify = (f, args, surface) => verifyEvidence(args, surface, {}, f.now)

function adapters(t) {
  return {
    persona({ platform, explicit }) {
      return { role: detectHostPersona({ platform, env: { DSH_PERSONA: explicit }, fsModule: { existsSync: () => false } }) }
    },
    pitch({ pitch }) { return computeAcousticProfile({}, { pitch }) },
    async wake({ mode }) {
      let at = mode === 'quiet' ? Date.parse('2026-11-13T03:00:00+08:00') : noon
      let message
      const agent = { id: 'replay', session: { id: 'replay', events: [{ type: 'turn/start', data: { turn: 0 } }] },
        followup(value) { message = value } }
      const wake = createWake({}, { dataDir: sandbox(t), now: () => at })
      if (mode !== 'quiet') assert.equal((await wake('继续', { agent })).ok, true)
      if (mode !== 'same' && mode !== 'quiet') agent.session.events = [{ type: 'turn/start', data: { turn: 1 } }]
      if (mode === 'self') {
        at += 60_000
        agent.session.events.push({ type: 'user/message', data: message })
      }
      return wake('再来一次', { agent })
    },
    memory({ old, next }) {
      const dataDir = sandbox(t)
      const memory = new MemoryService({ dataDir })
      try {
        const before = memory.remember({ kind: 'preference', content: old })
        const after = memory.correct(before.id, next)
        const records = readFileSync(path.join(dataDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
        return { content: after.content, retired: memory.inspect(before.id).status === 'superseded',
          atomic: records.length === 2 && records[1].replaces[0] === before.id && records[1].entry.id === after.id }
      } finally { memory.close() }
    },
    async vision({ tokenCost, frames }) {
      const tools = new Map()
      const data = { status: 'playing', watchSessionId: 'watch', timelineId: 'timeline',
        playbackPositionSec: 11, watchedInterval: [0, 11], subtitles: [], timecodes: [10], frameCount: 1,
        sceneAtSec: 10, cueId: 'cue', tokenCost }
      const image = { type: 'image', mimeType: 'image/png',
        data: Buffer.from('89504e470d0a1a0a0000000d494844520000030000000300', 'hex').toString('base64') }
      const cleanup = []
      registerWatch({ tools: { register(tool) { tools.set(tool.name, tool) } },
        effect: effect => cleanup.push(effect()), get: key => key === 'attachments' ? { saveImage: () => ({ id: 'image' }) } : null },
        {}, { gatewayUrl: 'http://127.0.0.1:28765', defineTool: tool => tool, callGatewayTool: async () => ({ ok: true, content: [
          { type: 'text', text: JSON.stringify(data) }, ...Array(frames).fill(image),
        ] }) })
      try {
        const response = await tools.get('pc_watch_get_summary').execute({}, { agent: { id: 'owner' } })
        return { status: response.tokenCost === 384 && response.images?.length === 1 ? 'valid' : response.status }
      } finally { for (const dispose of cleanup) if (typeof dispose === 'function') dispose() }
    },
    game({ guess }) {
      const state = startTwenty({ target: '鲸鱼', target_category: '动物' })
      try { return { verified: twentyAction(state, { action: 'surrender', input: guess }).done } }
      catch { return { verified: false } }
    },
    privacy({ mode }) {
      const f = fixture(t)
      const source = mode === 'public' ? group : direct
      const row = f.footprint.record(chatArgs, source, (args, surface) => verify(f, args, surface))
      const dest = mode === 'direct' ? direct : group
      return { visible: Boolean(f.surface.filter([{ id: row.id, visibility: 'PUBLIC_FRIENDLY' }], dest.channel, dest).length) }
    },
    care() {
      let at = noon
      const companion = createCompanion({ dataDir: sandbox(t), now: () => at })
      try {
        const { id } = companion.care.addCommitment('owner', { title: '散步', due_at: at + 1 }, { text: '约好散步', id: '1' })
        at += 2
        const due = companion.care.evaluate('owner').reason
        companion.care.complete('owner', id, { text: '散步已完成', id: '2' })
        return { due, repeat: companion.care.evaluate('owner').reason }
      } finally { companion.close() }
    },
    audio({ amplitude }) {
      const spans = [
        { start: 0, end: 1600, contextStart: 0, contextEnd: 2400 },
        { start: 1600, end: 3200, contextStart: 800, contextEnd: 3200 },
      ]
      const audio = joinVoiceChunks(spans, [new Int16Array(6000).fill(amplitude), new Int16Array(6000).fill(amplitude)])
      return { length: audio.length, flat: audio.every(sample => sample === amplitude), tail: audio.at(-1) }
    },
    async sister({ mode }) {
      const f = fixture(t, { role: 'xiaoman' })
      const other = fixture(t, { role: 'axing' })
      const packet = await other.sister.send({ type: 'whisper', summary: '晚安', payload: { text: '晚安' } })
      const body = JSON.stringify(packet)
      const mac = signature(body, mode === 'forged' ? 'forged key' : secret)
      try {
        const result = f.sister.ingest(body, mac, secret)
        if (mode === 'duplicate') return { ...f.sister.ingest(body, mac, secret), count: f.sister.receive().length }
        return result
      } catch { return { accepted: false } }
    },
    resonance({ topic }) {
      const f = fixture(t)
      f.footprint.record(chatArgs, direct, (args, surface) => verify(f, args, surface))
      return f.resonance.find({ topic }, { ...direct, utterance: topic, messageId: 'm2' })
    },
    footprint({ snippet }) {
      const f = fixture(t)
      try { f.footprint.record({ ...chatArgs, evidence_snippet: snippet }, direct, (args, surface) => verify(f, args, surface)) }
      catch { /* The digest asserts that a rejected cue never persists. */ }
      return { count: f.footprint.digest('2026-11', direct).entries.length }
    },
    cue({ owner }) {
      const f = fixture(t)
      f.surface.recordCue({ ...group, utterance: '公开话题：桂花糕' }, '桂花糕')
      return f.surface.cue('direct', { ...direct, ownerDirect: owner })
    },
  }
}

const scenarios = loadScenarios()
assert.ok(scenarios.length >= 30)
assert.equal(new Set(scenarios.map(item => item.id)).size, scenarios.length)
for (const scenario of scenarios) test(`replay ${scenario.id}`, async t => {
  const report = await runReplay([scenario], { ...adapters(t), model: () => scenario.referenceOutput })
  assert.equal(report.passed, 1, JSON.stringify(report.results))
})
