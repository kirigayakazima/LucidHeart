import { homedir } from 'node:os'
import path from 'node:path'
import { check, defaultRoot, InputError, openDb } from './db.js'
import { httpTransport, sisterChannel, sisterPath, sisterSchema } from './collaboration/sister_channel.js'
import { footprintSchema, growthFootprint, verifyEvidence } from './footprint/growth_footprint.js'
import { privacyBridge, privacySchema, surfaceContext } from './surface/privacy_bridge.js'
import { resonanceCallback, resonanceSchema } from './resonance/callback.js'
import { benchmarkSchema, modelEvaluator } from './benchmark/model_evaluator.js'
import { loadScenarios } from './benchmark/replay_runner.js'

export const name = 'dsh-evolution'
export const inject = ['tools', 'webServer']
const get = (ctx, key) => typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]

export function createEvolution({ dataDir = defaultRoot, role = 'xiaoman', now = Date.now, transport } = {}) {
  const databases = []
  const open = (file, schema) => {
    const db = openDb(dataDir, file, schema)
    databases.push(db)
    return db
  }
  const close = () => { while (databases.length) databases.pop().close() }
  try {
    const sister = sisterChannel(open('sister_channel', sisterSchema), { role, now, transport })
    const growthDb = open('growth', footprintSchema + privacySchema + resonanceSchema)
    const footprint = growthFootprint(growthDb, now)
    const surface = privacyBridge(growthDb, now, footprint.get)
    const resonance = resonanceCallback(growthDb, now, footprint.candidates)
    const models = modelEvaluator(open('benchmark', benchmarkSchema), now)
    return { sister, footprint, surface, resonance, models, close }
  } catch (error) {
    close()
    throw error
  }
}

const string = { type: 'string' }
const integer = { type: 'integer' }
const record = { type: 'object', properties: {}, additionalProperties: true }
const memories = { type: 'array', items: { oneOf: [string, record] } }
const models = { type: 'array', items: record }

async function receiveRequest(req, res, sister, secret) {
  const reply = (status, data) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(data))
  }
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > 8192) {
        reply(413, { error: 'packet_too_large' })
        return
      }
      chunks.push(chunk)
    }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    reply(200, sister.ingest(body, req.headers['x-sister-signature'], secret))
  } catch {
    if (!res.headersSent) reply(400, { error: 'invalid_packet' })
  }
}

export function apply(ctx, config = {}) {
  const role = config.role || (process.platform === 'win32' ? 'axing' : 'xiaoman')
  const root = role === 'axing' ? path.join(homedir(), '.dsh', 'evolution') : defaultRoot
  const secret = process.env.DSH_EVOLUTION_SISTER_SECRET
  check(!config.sisterUrl || secret?.length >= 32, '协作需要设置 DSH_EVOLUTION_SISTER_SECRET')
  const transport = config.sisterUrl ? httpTransport(config.sisterUrl, secret) : undefined
  const suite = createEvolution({ role, dataDir: path.resolve(config.dataDir || root), transport })
  ctx.effect(() => suite.close)
  if (secret?.length >= 32) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: sisterPath, handler: (req, res) => receiveRequest(req, res, suite.sister, secret),
  }))

  function tool(name, description, properties, required, execute, { owner = false } = {}) {
    ctx.tools.register({ name, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: record, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        try {
          exec?.signal?.throwIfAborted()
          const surface = surfaceContext(exec, config)
          check(surface, '无法核验当前用户会话')
          if (owner) check(surface.ownerDirect, '仅允许已配置的本人私聊使用')
          return { ok: true, data: await execute(args, surface, exec) }
        } catch (error) {
          if (!(error instanceof InputError)) throw error
          return { ok: false, error: error.message }
        }
      },
    })
  }
  async function gate(intent, exec) {
    const heart = get(ctx, 'heart')
    const snapshot = await heart?.getSnapshot?.()
    check(snapshot?.presence?.status !== 'asleep' && (await heart?.evaluateActivity?.({ intent }, { execution: exec }))?.suitable,
      'Heart 未批准该活动')
    exec?.signal?.throwIfAborted()
  }
  async function observe(type, evidence) {
    try {
      await get(ctx, 'heart')?.observe?.({ type, source: 'evolution', timestamp: new Date().toISOString(), confidence: 1, evidence })
    } catch (error) {
      console.warn('[dsh-evolution] Heart 观察回流失败', error.message)
    }
  }

  const owner = { owner: true }
  tool('sister_send', '在本人私聊中，经用户明确确认后发送姐妹协作包',
    { type: string, summary: string, payload: record, urgency: string }, ['type', 'summary'], async (args, surface, exec) => {
      check(typeof args.summary === 'string' && surface.utterance === '发给姐妹：' + args.summary, '需要用户明确确认协作摘要')
      // Only explicitly supplied text may cross the device boundary.
      for (const value of Object.values(args.payload ?? {})) {
        if (typeof value === 'string') check(surface.utterance.includes(value), '协作文本必须来自用户授权摘要')
      }
      await gate('sister_send', exec)
      return suite.sister.send(args, exec.signal)
    }, owner)
  tool('sister_receive', '拉取本端姐妹协作包', { limit: integer, unhandled_only: { type: 'boolean' } }, [],
    args => suite.sister.receive(args), owner)
  tool('sister_mark_handled', '记录本端协作处理回执', { id: string, result_note: string }, ['id', 'result_note'],
    args => suite.sister.markHandled(args), owner)
  tool('sister_retry', '重试尚未送达的协作包', {}, [], async (_args, _surface, exec) => {
    await gate('sister_send', exec)
    return { sent: await suite.sister.flush(exec.signal) }
  }, owner)
  tool('growth_record_footprint', '根据同会话可核验的证据登记真实成长足迹',
    { dimension: string, title: string, observation: string, evidence_type: string, evidence_id: string,
      evidence_snippet: string, visibility: string }, ['dimension', 'title', 'observation', 'evidence_type'],
    async (args, surface) => {
      const entry = suite.footprint.record(args, surface, (request, location) =>
        verifyEvidence(request, location, { companion: get(ctx, 'companion'), memory: get(ctx, 'memory') }, Date.now))
      if (entry) await observe('footprint_recorded', { id: entry.id, dimension: entry.dimension })
      return entry
    })
  tool('growth_generate_digest', '输出当前场景可见的月度陪伴手账', { month: string }, ['month'],
    (args, surface) => suite.footprint.digest(args.month, surface))
  tool('companion_resonance_find', '根据当前用户提到的关键词回顾真实共同经历',
    { topic: string, current_mood: string }, ['topic'], async (args, surface, exec) => {
      const snapshot = await get(ctx, 'heart')?.getSnapshot?.()
      if (snapshot?.mood?.state === 'tired') return { has_resonance: false, reason: 'mood' }
      await gate('companion_resonance', exec)
      return suite.resonance.find(args, surface)
    })
  tool('surface_bridge_filter', '按宿主当前可见性过滤已登记足迹 ID',
    { memories, target_surface: string }, ['memories', 'target_surface'],
    (args, surface) => suite.surface.filter(args.memories, args.target_surface, surface))
  tool('surface_bridge_cue', '在本人私聊中承接近期明确公开的主群话题', { session_type: string }, ['session_type'],
    (args, surface) => suite.surface.cue(args.session_type, surface))
  tool('surface_bridge_record', '登记用户明确公开的主群话题', { topic: string }, ['topic'],
    (args, surface) => suite.surface.recordCue(surface, args.topic))
  tool('evolution_model_compare', '对同一组场景的实测模型样本生成 JSON 与 Markdown 对照报告',
    { models }, ['models'], args => suite.models.compare(loadScenarios().filter(item => item.adapter === 'model'), args.models), owner)
}
