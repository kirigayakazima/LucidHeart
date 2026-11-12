import { createWake } from './wake.js'

export const name = 'dsh-heart-wake'
export const inject = ['tools', 'agents']

export function apply(ctx, config = {}) {
  const wake = createWake(ctx, { dataDir: config.dataDir })
  ctx.tools.register({
    name: 'heart_wake',
    description: '在当前会话排入一轮自唤醒以继续思考。遵守同轮锁、15 秒冷却、静音时段和频次限额。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '下一轮要继续思考的内容。' } },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' },
          reason: { type: 'string' }, messageId: { type: 'string' } },
        required: ['ok', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: (args, exec) => wake(args?.text, exec),
  })
}
