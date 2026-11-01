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
})
