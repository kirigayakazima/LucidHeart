import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

describe('@dsh/rvc Cordis Plugin & Heart Protocol v1 Integration', () => {
  function createMockCtx() {
    const tools = new Map()
    const events = new Map()
    const observed = []
    let allowActivity = true
    let sentVoices = []

    return {
      tools: {
        register(def) {
          tools.set(def.name, def)
        },
      },
      on(event, handler) {
        events.set(event, handler)
      },
      emit(event, payload) {
        const h = events.get(event)
        if (h) h(payload)
      },
      heart: {
        getSnapshot() {
          return {
            mood: {
              state: 'joy',
              arousal: 0.75,
              valence: 0.5,
              energy: 0.8,
            },
          }
        },
        evaluateActivity(intent) {
          if (!allowActivity) {
            return { suitable: false, reason: 'quiet-hours' }
          }
          return { suitable: true, reason: 'ok' }
        },
        async observe(obs) {
          observed.push(obs)
        },
      },
      qqbotMediaSender: {
        async sendVoice(target, src) {
          sentVoices.push({ target, src })
        },
      },
      _getTool: (n) => tools.get(n),
      _observed: observed,
      _sentVoices: sentVoices,
      _setAllowActivity: (val) => { allowActivity = val },
    }
  }

  test('正确注册 rvc_speak 与 rvc_sing 工具', () => {
    const ctx = createMockCtx()
    apply(ctx, { mock: true })

    assert.ok(ctx._getTool('rvc_speak'), '必须注册 rvc_speak')
    assert.ok(ctx._getTool('rvc_sing'), '必须注册 rvc_sing')
  })

  test('正常执行 rvc_speak：自动计算情绪声学参数并回流 Heart', async () => {
    const ctx = createMockCtx()
    apply(ctx, { mock: true })

    const tool = ctx._getTool('rvc_speak')
    const res = await tool.execute({ text: '你好呀姐姐！' })

    assert.equal(res.ok, true)
    assert.match(res.audio_file, /mock_dv5_.*\.wav/)
    assert.equal(res.acoustic.pitch, 0, '元气心境下音高应为 0 (P0)')
    assert.equal(res.sent_to_qq, true, '应默认调用 QQ sendVoice')

    // 验证 Heart observe 成功捕获发声经验
    assert.equal(ctx._observed.length, 1)
    const obs = ctx._observed[0]
    assert.equal(obs.type, 'audio')
    assert.equal(obs.source, 'rvc')
    assert.equal(obs.confidence, 1.0)
    assert.equal(obs.evidence.text, '你好呀姐姐！')
    assert.equal(obs.evidence.pitch, 0)
    assert.equal(obs.evidence.emotion, 'joy')
  })

  test('Heart evaluateActivity 拦截：静音期阻断高能耗语音生成', async () => {
    const ctx = createMockCtx()
    ctx._setAllowActivity(false) // 模拟静音期
    apply(ctx, { mock: true })

    const tool = ctx._getTool('rvc_speak')
    const res = await tool.execute({ text: '半夜偷偷说话' })

    assert.equal(res.ok, false)
    assert.equal(res.blocked_by_heart, true)
    assert.equal(res.reason, 'quiet-hours')
    assert.equal(ctx._observed.length, 0, '未实际发声，不应记录发声经验')
  })

  test('Cordis 禁止直接服务属性时仍自动投递QQ并回流Heart，且支持晚加载', async () => {
    const plain = createMockCtx()
    const services = new Map()
    const lookedUp = []
    const ctx = new Proxy({ ...plain, get(name) { lookedUp.push(name); return services.get(name) } }, {
      get(target, key) {
        if (['heart', 'qqbotMediaSender', 'pcBridge', 'fullawake'].includes(key)) throw Error(`cannot get property "${key}" without inject`)
        return Reflect.get(target, key)
      },
    })
    apply(ctx, { mock: true })
    services.set('heart', plain.heart)
    services.set('qqbotMediaSender', plain.qqbotMediaSender)
    services.set('pcBridge', { isOnline: () => false })
    const result = await plain._getTool('rvc_speak').execute({ text: '服务晚加载也能正常发送' })
    assert.equal(result.sent_to_qq, true)
    assert.equal(result.heart_observation, 'recorded')
    assert.equal(result.qq_delivery.status, 'sent')
    assert.equal(plain._sentVoices.length, 1)
    assert.equal(plain._observed.length, 1)
    assert.deepEqual(lookedUp, ['heart', 'qqbotMediaSender', 'pcBridge'])
  })

  test('QQ发送关闭或发送失败有明确结果，不误报成功', async () => {
    const ctx = createMockCtx()
    apply(ctx, { mock: true, autoSendQq: false })
    const disabled = await ctx._getTool('rvc_speak').execute({ text: '不发送' })
    assert.equal(disabled.sent_to_qq, false)
    assert.equal(disabled.qq_delivery.reason, 'disabled_by_config')
    assert.equal(ctx._sentVoices.length, 0)
    apply(ctx, { mock: true })
    ctx.qqbotMediaSender.sendVoice = async () => { throw Error('test failure') }
    const failed = await ctx._getTool('rvc_speak').execute({ text: '保留音频并报告发送错误' })
    assert.equal(failed.ok, true)
    assert.equal(failed.sent_to_qq, false)
    assert.equal(failed.qq_delivery.status, 'failed')
    assert.equal(failed.qq_delivery.error, 'test failure')
    assert.equal(failed.heart_observation, 'recorded')
  })

  test('rvc_speak forwards host execution context separately from model arguments', async () => {
    const ctx = createMockCtx()
    const exec = { agent: { session: { events: [
      { type: 'user/message', data: { role: 'user', source: { kind: 'user' } } },
    ] } } }
    ctx.heart.evaluateActivity = (intent, context) => {
      assert.equal(context.execution, exec)
      assert.equal(intent.origin, undefined)
      return { suitable: true, origin: 'user_request', reason: 'ok', quotaApplied: false }
    }
    apply(ctx, { mock: true })
    const result = await ctx._getTool('rvc_speak').execute({ text: '用户让我说话', origin: 'autonomous' }, exec)
    assert.equal(result.activity_gate.origin, 'user_request')
    assert.equal(result.activity_gate.quotaApplied, false)
  })
})
