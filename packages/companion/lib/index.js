import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { defaultDataDir, InputError, object, openDb, requireThat, str } from './db.js'
import { scopeOf, service, userEvidence } from './context.js'
import { activityEngine, activitySchema } from './activity/engine.js'
import { startTwenty, twentyAction } from './activity/twenty_questions.js'
import { startIdiom, idiomAction } from './activity/idiom_chain.js'
import { jukebox, jukeboxSchema } from './jukebox/playlist.js'
import { projectManager, projectSchema } from './projects/project_mgr.js'
import { idleCare, idleSchema } from './care/idle_care.js'
import { interestSchema, recordInterest } from './care/interest.js'
import { growth, growthSchema } from './care/growth.js'
import { taskLedger, taskSchema } from './tasks/ledger.js'

export const name = 'dsh-companion'
export const inject = ['tools']

export function createCompanion({ dataDir = defaultDataDir, now = Date.now, dispatch } = {}) {
  const connections = []
  const open = (file, schema) => {
    const db = openDb(dataDir, file, schema)
    connections.push(db)
    return db
  }
  const close = () => { while (connections.length) connections.pop().close() }
  try {
    const activities = activityEngine(open('activity', activitySchema), now)
    const projects = projectManager(open('projects', projectSchema), now)
    const tasks = taskLedger(open('tasks', taskSchema), now)
    const careDb = open('care', idleSchema + interestSchema + growthSchema)
    const care = idleCare(careDb, now)
    const experience = growth(careDb, now)
    const music = jukebox(open('jukebox', jukeboxSchema), tasks, now, dispatch)
    tasks.recoverStale()
    return { activities, projects, tasks, care, experience, music, close,
      recordInterest: (scope, args, evidence) => recordInterest(careDb, now, scope, args, evidence) }
  } catch (error) {
    close()
    throw error
  }
}

const string = { type: 'string' }
const integer = { type: 'integer' }
const record = { type: 'object', additionalProperties: true }
const choice = (...values) => ({ type: 'string', enum: values })

export function apply(ctx, config = {}) {
  const dispatch = async (song, exec) => {
    requireThat(exec?.token && exec.agent && exec.signal, '缺少 RVC 子调用所需的宿主执行上下文')
    const result = await ctx.tools.execute({ name: 'rvc_sing', callId: randomUUID(),
      rootCallId: exec.rootCallId ?? exec.callId, parent: exec.token, agent: exec.agent, signal: exec.signal,
      arguments: { song_title: song.title, pitch: song.preferred_pitch } })
    return result.isError ? null : result.value
  }
  const companion = createCompanion({ dataDir: path.resolve(config.dataDir || defaultDataDir), dispatch })
  const { activities, projects, tasks, care, experience, music } = companion
  ctx.effect?.(() => companion.close)
  ctx.provide?.('companion', companion)

  ctx.on?.('agent/inbox/claimed', ({ agent, message }) => {
    const scope = scopeOf(agent)
    if (scope && message?.source?.kind === 'user' && message.id) {
      try { care.noteInteraction(scope, message.id) }
      catch (error) { console.warn('[dsh-companion] 无法登记用户互动', error.message) }
    }
  }, { global: true })

  async function gate(intent, exec, userInitiated = true) {
    const heart = service(ctx, 'heart')
    if (!heart?.evaluateActivity) return { suitable: false, reason: 'heart_unavailable' }
    const snapshot = await heart.getSnapshot?.()
    if (snapshot?.presence?.status === 'asleep') return { suitable: false, reason: 'asleep' }
    return heart.evaluateActivity({ intent }, userInitiated ? { execution: exec } : {})
  }

  async function observe(type, evidence) {
    try {
      await service(ctx, 'heart')?.observe?.({ type, source: 'companion', timestamp: new Date().toISOString(),
        confidence: 1, evidence })
    } catch (error) {
      console.warn('[dsh-companion] Heart 观察回流失败', error.message)
    }
  }

  function tool(suffix, description, properties, required, run) {
    ctx.tools.register({
      name: 'companion_' + suffix, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: record, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        try {
          exec?.signal?.throwIfAborted()
          const scope = str(scopeOf(exec?.agent), '会话')
          const data = await run(scope, object(args), exec)
          return { ok: true, data: data ?? null }
        } catch (error) {
          if (!(error instanceof InputError)) throw error
          return { ok: false, error: error.message }
        }
      },
    })
  }

  tool('activity_start', '开始活动或开一局游戏。二十问可通过 target_hash 和 salt 预先承诺题目。',
    { type: string, title: string, initial_state: record }, ['type', 'title'], async (scope, args, exec) => {
      const decision = await gate('companion_activity', exec)
      requireThat(decision?.suitable, 'Heart 未批准活动：' + (decision?.reason ?? 'unknown'))
      exec?.signal?.throwIfAborted()
      const initial = object(args.initial_state ?? {})
      let state = { ...initial, round: 0 }
      if (args.type === 'game') {
        requireThat(['twenty_questions', 'idiom_chain'].includes(initial.game), '请选择二十问或成语接龙')
        state = initial.game === 'twenty_questions' ? startTwenty(initial) : startIdiom(initial)
      }
      const activity = activities.start(scope, args, state)
      await observe('activity_started', { id: activity.id, type: activity.type })
      return activity
    })
  for (const [action, description, fields] of [
    ['step', '记录一次活动步骤', { delta_state: record, action_summary: string }],
    ['pause', '暂停当前活动', { reason: string }],
    ['resume', '恢复已暂停活动', {}],
    ['finish', '结算当前活动', { summary: string, outcome: string }],
    ['abort', '放弃当前或已暂停活动', { reason: string }],
  ]) {
    tool('activity_' + action, description, { id: string, ...fields }, ['id'], async (scope, args, exec) => {
      if (action === 'resume') {
        requireThat((await gate('companion_activity', exec))?.suitable, 'Heart 未批准恢复活动')
        exec?.signal?.throwIfAborted()
      }
      const result = activities.change(scope, args.id, action, args)
      if (action === 'finish') await observe('activity_finished', { id: result.id, summary: result.state.summary })
      return result
    })
  }
  tool('game_action', '在当前游戏提问、回答、猜测、认输、揭晓或求提示',
    { action: choice('ask', 'answer', 'guess', 'surrender', 'hint', 'reveal'), input: string, guess: string }, ['action'],
    async (scope, args) => {
      const result = activities.game(scope, state => state.game === 'twenty_questions' ? twentyAction(state, args) : idiomAction(state, args))
      if (result.status === 'completed') await observe('activity_finished', { id: result.id, game: result.state.game })
      return result
    })
  tool('jukebox_list', '查看曲库和当前会话队列', {}, [], scope => music.list(scope))
  tool('jukebox_add', '加入点歌队列。曲名应能在 RVC 本地曲库找到',
    { title: string, artist: string, pitch: integer, requester: choice('user', 'xiaoman') }, ['title'],
    async (scope, args, exec) => {
      requireThat((await gate('companion_jukebox', exec))?.suitable, 'Heart 未批准点歌')
      exec?.signal?.throwIfAborted()
      return music.add(scope, { ...args, requester: userEvidence(exec) && args.requester !== 'xiaoman' ? 'user' : 'xiaoman' }, exec)
    })
  tool('jukebox_next', '确认上一首并尝试启动队列中的下一首', {}, [], async (scope, _args, exec) => {
    requireThat((await gate('companion_jukebox', exec))?.suitable, 'Heart 未批准点歌')
    exec?.signal?.throwIfAborted()
    return music.next(scope, exec)
  })
  tool('jukebox_history', '查找本会话已合成歌曲', { limit: integer }, [], (scope, args) => music.history(scope, args.limit))
  tool('project_create', '建立跨日小项目',
    { name: string, goal: string, milestones: { type: 'array', items: string } }, ['name', 'goal', 'milestones'], projects.create)
  tool('project_checkin', '追加打卡并可选完成一个里程碑',
    { project_id: string, note: string, milestone_index_done: integer }, ['project_id', 'note'], projects.checkin)
  tool('project_status', '查看项目进度', { project_id: string }, ['project_id'], (scope, args) => projects.status(scope, args.project_id))

  tool('care_evaluate', '按可信互动记录与约定评估关怀，仅返回建议',
    { session_gap_seconds: integer }, [], async (scope, _args, exec) => {
      const decision = await gate('companion_care', exec, false)
      if (!decision?.suitable) return { should_care: false, reason: decision?.reason ?? 'heart_blocked' }
      exec?.signal?.throwIfAborted()
      const evidence = userEvidence(exec)
      const entry = service(ctx, 'memory')?.commitments?.getActiveCommitmentCare?.(new Date())
      // Memory is a shared reference. Companion only imports it when this turn
      // mentions the same commitment; it never resolves the Memory entry.
      const due = entry?.status === 'expired' && evidence?.text.includes(entry.title) ? entry : null
      return care.evaluate(scope, evidence?.id, due)
    })
  tool('care_commitment_add', '记录用户已说定的约定与截止时间',
    { title: string, due_at: integer }, ['title', 'due_at'], (scope, args, exec) => care.addCommitment(scope, args, userEvidence(exec)))
  tool('care_commitment_complete', '按当前真实用户确认结清 Companion 侧的约定',
    { id: string }, ['id'], (scope, args, exec) => care.complete(scope, args.id, userEvidence(exec)))
  tool('interest_record', '依据本轮真实用户消息积累兴趣候选',
    { topic: string, details: string, enthusiasm: integer }, ['topic', 'details', 'enthusiasm'],
    (scope, args, exec) => companion.recordInterest(scope, args, userEvidence(exec)))
  tool('growth_observe', '记录成长候选；引用须来自本轮用户原话',
    { category: string, insight: string, quote: string }, ['category', 'insight'],
    (scope, args, exec) => experience.observe(scope, args, userEvidence(exec)))
  tool('growth_promote', '有明确用户确认或七天三次强化时晋升到受控配置',
    { id: string, approval_source: choice('user_confirmation', 'reinforcement') }, ['id', 'approval_source'],
    async (scope, args, exec) => {
      const result = experience.promote(scope, args, userEvidence(exec))
      if (result.audit_hash) await observe('experience_promoted', { id: result.id, audit_hash: result.audit_hash })
      return result
    })
  tool('growth_list', '读取本会话已晋升的受控配置', {}, [], scope => experience.approved(scope))

  function ownTask(scope, id) {
    const task = tasks.get(id)
    requireThat(task?.target === scope, '找不到任务')
    return task
  }
  tool('task_create', '创建当前会话的通用异步任务', { kind: string, idempotency_key: string, payload: record }, ['kind'],
    (scope, args) => tasks.create(args.kind, args.idempotency_key ? JSON.stringify([scope, args.idempotency_key]) : null, scope, args.payload))
  tool('task_update', '更新当前会话的异步任务',
    { id: string, status: choice('processing', 'completed', 'failed', 'delivered'), progress: integer, result: record, error: string },
    ['id', 'status'], (scope, args) => {
      ownTask(scope, args.id)
      return tasks.update(args.id, args.status, args.progress, args)
    })
  tool('task_get', '查询当前会话的异步任务', { id: string }, ['id'], (scope, args) => ownTask(scope, args.id))
}
