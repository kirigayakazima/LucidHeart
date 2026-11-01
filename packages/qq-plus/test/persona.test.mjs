import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  XIAOMAN_PROFILE,
  AXING_PROFILE,
  detectHostPersona,
  resolvePersonaConfig,
  computeHeartCadence,
} from '../lib/personas.js'

test('小满与阿醒的基础画像属性完整且不可篡改', () => {
  assert.equal(XIAOMAN_PROFILE.id, 'xiaoman')
  assert.equal(XIAOMAN_PROFILE.role, '妹妹')
  assert.equal(XIAOMAN_PROFILE.device, 'phone')
  assert.ok(XIAOMAN_PROFILE.wakeWords.includes('小满'))
  assert.ok(XIAOMAN_PROFILE.wakeWords.includes('妹妹'))

  assert.equal(AXING_PROFILE.id, 'axing')
  assert.equal(AXING_PROFILE.role, '姐姐')
  assert.equal(AXING_PROFILE.device, 'win')
  assert.ok(AXING_PROFILE.wakeWords.includes('阿醒'))
  assert.ok(AXING_PROFILE.wakeWords.includes('姐姐'))
})

test('第一层判定：显式 userConfig.persona 指定时具有最高优先级', () => {
  const mockCtx = {
    heart: {
      getSnapshot: () => ({ device: 'phone' }), // 即使 Heart 报 phone
    },
  }
  // 显式指定为 axing
  const config = resolvePersonaConfig(mockCtx, { persona: 'axing' })
  assert.equal(config.persona, 'axing')
  assert.equal(config.name, '阿醒')
  assert.ok(config.wakeWords.includes('阿醒'))
})

test('第二层判定：未显式指定时，自动从 Heart 快照 device 识别', () => {
  // 模拟手机端 Heart 快照
  const phoneCtx = {
    heart: {
      getSnapshot: () => ({ device: 'phone' }),
    },
  }
  const phoneRes = resolvePersonaConfig(phoneCtx, {})
  assert.equal(phoneRes.persona, 'xiaoman')
  assert.equal(phoneRes.name, '小满')
  assert.ok(phoneRes.wakeWords.includes('小满'))

  // 模拟 PC 端 Heart 快照
  const winCtx = {
    heart: {
      getSnapshot: () => ({ device: 'win' }),
    },
  }
  const winRes = resolvePersonaConfig(winCtx, {})
  assert.equal(winRes.persona, 'axing')
  assert.equal(winRes.name, '阿醒')
  assert.ok(winRes.wakeWords.includes('阿醒'))
})

test('第三层判定：无 Heart 服务时，根据宿主特征探针探测', () => {
  // 模拟 Windows
  const winPersona = detectHostPersona({ platform: 'win32', env: {} })
  assert.equal(winPersona, 'axing')

  // 模拟环境变量显式覆盖
  const envPersona = detectHostPersona({
    platform: 'win32',
    env: { DSH_PERSONA: 'xiaoman' },
  })
  assert.equal(envPersona, 'xiaoman')

  // 模拟 Android 桥文件存在
  const mockFs = {
    existsSync: (p) => p.endsWith('.bridge_headers'),
  }
  const androidPersona = detectHostPersona({
    platform: 'linux',
    env: {},
    homedir: '/root',
    fsModule: mockFs,
  })
  assert.equal(androidPersona, 'xiaoman')
})

test('Heart 情绪联动打字节奏计算（computeHeartCadence）', () => {
  const base = {
    minChars: 100,
    targetChars: 60,
    maxSegments: 4,
    delayMs: 600,
  }

  // 1. 无快照时保持原样
  const noChange = computeHeartCadence(base, null)
  assert.deepEqual(noChange, base)

  // 2. 疲劳状态 (energy < 0.35)：延迟拉长，气泡数压缩
  const tiredSnap = {
    mood: { energy: 0.2, arousal: 0.3 },
  }
  const tired = computeHeartCadence(base, tiredSnap)
  assert.ok(tired.delayMs > base.delayMs, '疲劳时打字停顿应变长')
  assert.ok(tired.maxSegments <= 2, '疲劳时消息气泡数应减少')

  // 3. 兴奋状态 (arousal > 0.65)：打字速度加快，气泡连珠炮
  const excitedSnap = {
    mood: { energy: 0.8, arousal: 0.85 },
  }
  const excited = computeHeartCadence(base, excitedSnap)
  assert.ok(excited.delayMs < base.delayMs, '兴奋时打字速度应加快')
  assert.ok(excited.targetChars < base.targetChars, '兴奋时单段期望更短小轻快')
})

test('出站切分参数平铺与嵌套双兼容支持', () => {
  // 1. 顶层平铺配置 (如直接在 config 根级写 minChars: 45)
  const flatRes = resolvePersonaConfig({}, { minChars: 45, targetChars: 30, delayMs: 300 })
  assert.equal(flatRes.split.minChars, 45)
  assert.equal(flatRes.split.targetChars, 30)
  assert.equal(flatRes.split.delayMs, 300)

  // 2. 标准嵌套配置 (config.split.*)
  const nestedRes = resolvePersonaConfig({}, { split: { minChars: 55, targetChars: 40 } })
  assert.equal(nestedRes.split.minChars, 55)
  assert.equal(nestedRes.split.targetChars, 40)

  // 3. 嵌套配置优先级高于顶层平铺
  const overrideRes = resolvePersonaConfig({}, { minChars: 45, split: { minChars: 65 } })
  assert.equal(overrideRes.split.minChars, 65)
})
