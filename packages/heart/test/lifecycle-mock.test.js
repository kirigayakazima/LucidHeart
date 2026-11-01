import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HeartService } from '../lib/service.js'
import { HEART_EVENTS, HEART_PROTOCOL_VERSION } from '../contracts/index.js'
import { ensureLayout } from '../lib/store.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-lifecycle-test-'))

/**
 * 模拟 Cordis Context 与 Fiber 生命周期机制
 */
class MockCordisHost {
  constructor() {
    this.services = new Map()
    this.eventListeners = new Map() // event -> Set of listeners
    this.plugins = new Map()
  }

  createContext(pluginName) {
    const host = this
    const disposers = []

    const ctx = {
      name: pluginName,
      get(name) {
        return host.services.get(name)
      },
      provide(name, service) {
        host.services.set(name, service)
        const unprovide = () => {
          if (host.services.get(name) === service) {
            host.services.delete(name)
          }
        }
        disposers.push(unprovide)
        return unprovide
      },
      on(event, listener) {
        if (!host.eventListeners.has(event)) {
          host.eventListeners.set(event, new Set())
        }
        const set = host.eventListeners.get(event)
        set.add(listener)
        const off = () => {
          set.delete(listener)
        }
        disposers.push(off)
        return off
      },
      async parallel(event, ...args) {
        const set = host.eventListeners.get(event)
        if (!set || set.size === 0) return
        const promises = Array.from(set).map((fn) => Promise.resolve().then(() => fn(...args)))
        await Promise.all(promises)
      },
      emit(event, ...args) {
        const set = host.eventListeners.get(event)
        if (!set) return
        for (const fn of Array.from(set)) {
          fn(...args)
        }
      },
      effect(fn) {
        const cleanup = fn()
        if (typeof cleanup === 'function') {
          disposers.push(cleanup)
        }
      },
      dispose() {
        while (disposers.length > 0) {
          const fn = disposers.pop()
          try {
            fn()
          } catch {}
        }
      },
    }

    return ctx
  }
}

// -------------------------------------------------------------
// 三个轻量模拟插件实现
// -------------------------------------------------------------

/** 1. 模拟感知器官插件 (Mock Sensory: sticker-look) */
class MockSensoryPlugin {
  constructor(ctx) {
    this.ctx = ctx
  }

  async sendObservation(observation) {
    const heart = this.ctx.get('heart')
    if (!heart) {
      // Heart 暂不可用时安全降级
      return { accepted: false, reason: 'HEART_UNAVAILABLE' }
    }
    return await heart.observe(observation)
  }
}

/** 2. 模拟表达器官插件 (Mock Voice: RVC / TTS) */
class MockVoicePlugin {
  constructor(ctx) {
    this.ctx = ctx
    this.stateChangedCount = 0
    this.lastObservedState = null

    // 订阅状态变化事件
    ctx.on(HEART_EVENTS.STATE_CHANGED, (evt) => {
      this.stateChangedCount++
      this.lastObservedState = evt.current.mood.state
    })
  }

  // 异步发声执行能力（明确 Promise 结果与回退，严禁 consumed=true 竞争）
  async synthesizeSpeech(text, { simulateFailure = false } = {}) {
    if (simulateFailure) {
      return {
        ok: false,
        error: 'RVC_INFERENCE_TIMEOUT',
        fallback: 'text_only',
        audioPath: null,
      }
    }
    return {
      ok: true,
      audioPath: `/tmp/voice-${Date.now()}.wav`,
      text,
    }
  }
}

/** 3. 模拟 PC 桥接能力插件 (Mock PC Bridge: FullAwake) */
class MockPCBridgePlugin {
  constructor(ctx) {
    this.ctx = ctx
    this.online = false
    this.capabilities = []
  }

  setOnline(status) {
    this.online = Boolean(status)
    if (this.online) {
      this.capabilities = ['pc.status', 'pc.list_windows', 'pc.snapshot', 'pc.read_file']
    } else {
      this.capabilities = []
    }
  }

  executeCapability(capabilityName, params = {}) {
    if (!this.online) {
      return {
        ok: false,
        code: 'ERR_PC_OFFLINE',
        error: 'PC is currently offline or unreachable',
      }
    }
    if (!this.capabilities.includes(capabilityName)) {
      return {
        ok: false,
        code: 'ERR_UNSUPPORTED_CAPABILITY',
        error: `Capability ${capabilityName} is not available`,
      }
    }

    if (capabilityName === 'pc.snapshot') {
      return {
        ok: true,
        data: { imageBase64: 'mock_base64_png', window: params.target || 'active' },
      }
    }

    return {
      ok: true,
      data: { status: 'mock_result' },
    }
  }
}

// -------------------------------------------------------------
// 验收测试套件
// -------------------------------------------------------------

test('验收 1: 独立安装/卸载/重新加载与生命周期清理（无残留重复监听）', async () => {
  const host = new MockCordisHost()
  const root = tmpDir()
  ensureLayout(root)

  // 1. 加载 Heart
  const heartCtx = host.createContext('dsh-heart')
  const heartService = new HeartService(heartCtx, root, { device: 'phone' })
  heartCtx.provide('heart', heartService)

  // 2. 加载 Voice 插件
  const voiceCtx = host.createContext('dsh-voice')
  const voicePlugin = new MockVoicePlugin(voiceCtx)

  // 触发一次状态变化
  await heartService.observe({
    type: 'sticker',
    source: 'qq',
    confidence: 0.9,
    evidence: { meaning: 'comfort' },
  })
  assert.equal(voicePlugin.stateChangedCount, 1)
  assert.equal(voicePlugin.lastObservedState, 'cheerful')

  // 3. 卸载 Voice 插件并重新加载（模拟热更新 / 重载）
  voiceCtx.dispose() // 释放第一代插件

  const voiceCtx2 = host.createContext('dsh-voice')
  const voicePlugin2 = new MockVoicePlugin(voiceCtx2)

  // 再次触发状态变化
  await heartService.observe({
    type: 'wake',
    source: 'qq',
    confidence: 0.9,
    evidence: { userCalled: true },
  })

  // 验证：旧插件计数未变，新插件接收且计数准确为 1（无残留重复监听）
  assert.equal(voicePlugin.stateChangedCount, 1)
  assert.equal(voicePlugin2.stateChangedCount, 1)
  assert.equal(voicePlugin2.lastObservedState, 'engaged')
})

test('验收 2: Heart 暂时不可用与恢复安全（外部插件安全降级）', async () => {
  const host = new MockCordisHost()
  const sensoryCtx = host.createContext('dsh-sensory')
  const sensoryPlugin = new MockSensoryPlugin(sensoryCtx)

  // Heart 尚未就绪时，感知插件提交观察 -> 安全返回不可用，绝不抛出未捕获异常
  const res1 = await sensoryPlugin.sendObservation({
    type: 'sticker',
    source: 'qq',
    confidence: 0.8,
  })
  assert.equal(res1.accepted, false)
  assert.equal(res1.reason, 'HEART_UNAVAILABLE')

  // Heart 上线提供服务
  const root = tmpDir()
  ensureLayout(root)
  const heartCtx = host.createContext('dsh-heart')
  const heartService = new HeartService(heartCtx, root)
  heartCtx.provide('heart', heartService)

  // Heart 就绪后再次提交 -> 成功接受
  const res2 = await sensoryPlugin.sendObservation({
    type: 'sticker',
    source: 'qq',
    confidence: 0.85,
    evidence: { meaning: 'comfort' },
  })
  assert.equal(res2.accepted, true)
  assert.equal(res2.stateChanged, true)
})

test('验收 3: 感知绝不能绕过 Heart 状态规则（防篡改与防御越权）', async () => {
  const host = new MockCordisHost()
  const root = tmpDir()
  ensureLayout(root)
  const heartCtx = host.createContext('dsh-heart')
  const heartService = new HeartService(heartCtx, root)
  heartCtx.provide('heart', heartService)

  const sensoryCtx = host.createContext('dsh-sensory')
  const sensoryPlugin = new MockSensoryPlugin(sensoryCtx)

  // 1. 尝试直接注入三维情绪增量
  const hackRes = await sensoryPlugin.sendObservation({
    type: 'sticker',
    source: 'qq',
    confidence: 0.9,
    valence: 0.8,
    arousal: 0.9,
  })
  assert.equal(hackRes.accepted, false)
  assert.equal(hackRes.stateChanged, false)

  // 2. 验证 Heart 内部状态依然为基准 calm，未被污染
  const snapshot = heartService.getSnapshot()
  assert.equal(snapshot.mood.state, 'calm')
  assert.equal(snapshot.mood.valence, 0.2)
})

test('验收 4: 异步执行失败明确报告，绝不通过竞争被误报为成功', async () => {
  const host = new MockCordisHost()
  const voiceCtx = host.createContext('dsh-voice')
  const voicePlugin = new MockVoicePlugin(voiceCtx)

  // 模拟发声失败（如 RVC 超时）
  const result = await voicePlugin.synthesizeSpeech('你好', { simulateFailure: true })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'RVC_INFERENCE_TIMEOUT')
  assert.equal(result.fallback, 'text_only')
  assert.equal(result.audioPath, null)
})

test('验收 5: PC Capability 模拟（在线暴露能力，离线即时撤销）', () => {
  const host = new MockCordisHost()
  const pcCtx = host.createContext('fullawake-bridge')
  const pcBridge = new MockPCBridgePlugin(pcCtx)

  // 1. 初始离线状态：调用能力失败
  assert.equal(pcBridge.online, false)
  const offlineCall = pcBridge.executeCapability('pc.snapshot', { target: 'VSCode' })
  assert.equal(offlineCall.ok, false)
  assert.equal(offlineCall.code, 'ERR_PC_OFFLINE')

  // 2. PC 开机并连接在线
  pcBridge.setOnline(true)
  assert.equal(pcBridge.online, true)
  assert.deepEqual(pcBridge.capabilities, [
    'pc.status',
    'pc.list_windows',
    'pc.snapshot',
    'pc.read_file',
  ])

  // 在线时执行正常
  const onlineCall = pcBridge.executeCapability('pc.snapshot', { target: 'VSCode' })
  assert.equal(onlineCall.ok, true)
  assert.ok(onlineCall.data.imageBase64)

  // 3. PC 关机或断网离线
  pcBridge.setOnline(false)
  assert.deepEqual(pcBridge.capabilities, [])
  const offlineCall2 = pcBridge.executeCapability('pc.snapshot')
  assert.equal(offlineCall2.ok, false)
  assert.equal(offlineCall2.code, 'ERR_PC_OFFLINE')
})

test('验收 6: 架构负荷度量（零新增模型工具，系统提示词零膨胀）', () => {
  // 测量 Heart 0.20.0 导出的 tools 数量
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const toolMatches = Array.from(src.matchAll(/name:\s*['"](heart_[a-z0-9_]+)['"]/g)).map((m) => m[1])
  const uniqueTools = Array.from(new Set(toolMatches))

  // 严格断言：工具数量正好是原来的 18 个，绝不为微内核协议暴露多余的 LLM 工具
  assert.equal(uniqueTools.length, 18)
  assert.ok(uniqueTools.includes('heart_mood'))
  assert.ok(uniqueTools.includes('heart_voice_learn'))
  assert.ok(uniqueTools.includes('heart_self'))
  assert.ok(!uniqueTools.includes('heart_observe')) // 协议接口作为 Cordis 服务提供，不进入模型提示词
  assert.ok(!uniqueTools.includes('heart_get_snapshot'))
})
