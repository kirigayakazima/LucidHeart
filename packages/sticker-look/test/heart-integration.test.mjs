// Heart Protocol v1 契约集成测试 (heart-integration.test.mjs)
// 验证 sticker-look 在看图完成后能够按照 Heart Protocol v1 规范上报观察事实，
// 并验证上报载荷能够被 Heart Validator 校验通过、被 Heart Service 映射为 cheerful 情绪。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { look } from '../lib/index.js'
import { inferStickerMeaning } from '../lib/look.js'
import { validateObservation } from '../../heart-plugin/contracts/validator.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const fixture = path.join(root, 'test', 'fixtures', 'move.gif')
const still = path.join(root, 'test', 'fixtures', 'still.png')

const config = {
  frames: 4,
  cols: 2,
  library: '',
  maxBytes: 32 * 1024 * 1024,
  outDir: path.join(root, 'test', 'tmp'),
  observeHeart: true,
}

let passed = 0
let failed = 0
function ok(cond, msg) {
  if (cond) {
    passed++
    console.log(`  [OK] ${msg}`)
  } else {
    failed++
    console.error(`  [FAIL] ${msg}`)
  }
}

console.log('[1. 意图提取与 Heart 契约对齐测试]')
const funnyIntent = inferStickerMeaning('这是一只搞笑小猫在跳舞哈哈哈', '', '')
ok(funnyIntent === 'funny', '搞笑文字识别为 funny')

const loveIntent = inferStickerMeaning('', '给你一个大大的拥抱喜欢你', '')
ok(loveIntent === 'comfort', '拥抱喜欢识别为 comfort')

const defaultIntent = inferStickerMeaning('系统截屏排查', '', '')
ok(defaultIntent === 'interaction', '普通截图识别为 interaction')

console.log('\n[2. Heart Validator 合规性测试]')
const samplePayload = {
  type: 'sticker',
  source: 'sticker-look',
  confidence: 0.85,
  evidence: {
    meaning: funnyIntent,
    isGif: true,
    frames: 4,
    how: 'animation',
    file: 'move.gif',
  },
  summary: '搞笑动图表情包',
}

const validation = validateObservation(samplePayload)
ok(validation.valid === true, 'Heart Validator 校验通过 (无违规直接写 mood 字段)')

console.log('\n[3. 无视觉模型时的降级与不崩溃测试]')
const mockCtxWithoutHeart = {
  get: (name) => undefined,
}

const fallbackRes = await look(mockCtxWithoutHeart, config, { image: fixture })
ok(fallbackRes && fallbackRes.message.includes('抽好了'), '无视觉模型时降级为 sheet-only')

console.log('\n[4. 模拟视觉模型与 Heart 连通测试]')
let observedPayload = null
const mockHeart = {
  async observe(input) {
    observedPayload = input
    return { accepted: true, observationId: 'obs-test-001', stateChanged: true }
  },
}

const mockLlm = {
  async *stream() {
    yield '画面：一只小红方块在有节奏地左右跳跃。\n意思：开心搞笑的大笑表情。\n一句话：非常搞笑。'
  },
}

const mockAttachments = {
  async saveImage() {
    return 'att-ref-123'
  },
}

const mockCtxWithHeart = {
  get: (name) => {
    if (name === 'heart') return mockHeart
    if (name === 'llm') return mockLlm
    if (name === 'attachments') return mockAttachments
    return undefined
  },
}

const lookConfig = {
  ...config,
  vision: {
    provider: 'test-provider',
    model: 'test-vision-model',
    maxTokens: 500,
    timeoutMs: 5000,
  },
}

const lookRes = await look(mockCtxWithHeart, lookConfig, { image: fixture, context: '朋友发来开心的乐子' })
ok(lookRes && lookRes.message.includes('画面：一只小红方块'), '读图工具正常返回识别文本')
ok(observedPayload !== null, '成功向 heart.observe() 汇报观察事实')
ok(observedPayload?.type === 'sticker', '上报 type 为 sticker')
ok(observedPayload?.source === 'sticker-look', '上报 source 为 sticker-look')
ok(observedPayload?.evidence?.meaning === 'funny', '意图准确映射为 funny')
ok(observedPayload?.confidence === 0.85, '置信度设为 0.85')

console.log(`\n========================================`)
console.log(`全部完成: ${passed} 项通过, ${failed} 项失败`)
console.log(`========================================`)
if (failed > 0) process.exit(1)
