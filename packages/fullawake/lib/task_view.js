const phase = new Map([
  ['queued', 'QUEUED'], ['demucs', 'SYNTHESIZING_DEMUCS'], ['rvc_convert', 'CONVERTING_RVC'],
  ['mastering', 'MIXING'], ['ready_local', 'READY_LOCAL'], ['delivering_qq', 'DELIVERING_QQ'],
])
const status = { pending: 'QUEUED', processing: 'PROCESSING', completed: 'READY_LOCAL',
  delivered: 'COMPLETED', failed: 'FAILED' }

export function taskView(task) {
  const detail = task.result
  const terminal = ['delivered', 'failed'].includes(task.status)
  const state = terminal || task.status === 'completed' ? status[task.status] : phase.get(detail?.phase) ?? status[task.status]
  return {
    task_id: task.id, kind: task.kind, status: state, progress: task.progress,
    queue_position: state === 'QUEUED' && Number.isInteger(detail?.queue_position) ? detail.queue_position : null,
    slice_progress: state === 'CONVERTING_RVC' ? detail?.slice_progress ?? null : null,
    eta_seconds: !terminal && Number.isFinite(detail?.eta_seconds) ? detail.eta_seconds : null,
    eta_stage: !terminal && Number.isFinite(detail?.eta_seconds) ? detail?.eta_stage ?? null : null,
    output_path: ['READY_LOCAL', 'DELIVERING_QQ', 'COMPLETED', 'FAILED'].includes(state) ? detail?.output_path ?? null : null,
    reason: task.error_message ?? null,
  }
}

export function registerTaskView(ctx, defineTool = spec => spec) {
  const disposers = []
  const output = { schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  function register(name, description, parameters, run) {
    disposers.push(ctx.tools.register(defineTool({ name, description, output, parameters,
      async execute(args, exec) {
        exec?.signal?.throwIfAborted()
        const agent = exec?.agent
        const scope = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
        const ledger = ctx.get?.('companion')?.tasks ?? (!ctx.get ? ctx.companion?.tasks : undefined)
        if (!scope || !ledger) return { ok: false, reason: 'task_ledger_unavailable' }
        return run(ledger, scope, args)
      },
    })))
  }
  register('task_status_query', '查询本会话任务实际进度、产物和失败原因',
    { task_id: { type: 'string', required: true } }, (ledger, scope, { task_id }) => {
      if (typeof task_id !== 'string' || !task_id.trim() || task_id.length > 500) return { ok: false, reason: 'task_not_found' }
      const task = ledger.get(task_id)
      return task?.target === scope ? { ok: true, task: taskView(task) } : { ok: false, reason: 'task_not_found' }
    })
  register('task_status_active', '查询本会话仍在排队、生成或待投递的任务', {},
    (ledger, scope) => ({ ok: true, tasks: ledger.active(scope).map(taskView) }))
  return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() }
}
