import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeText, validateDialogueQuality, exportTuningDataset } from '../lib/tuning_dataset.js'

test('TuningDataset: redacts phone numbers, emails, tokens, and concrete addresses', () => {
  const dirty = '我手机是 13812345678，邮箱是 test@example.com，密钥是 sk-1234567890abcdef1234567890，家住在上海市静安区延平路100号小区3栋。'
  const { text, redacted } = sanitizeText(dirty)

  assert.equal(redacted, true)
  assert.equal(text.includes('13812345678'), false)
  assert.equal(text.includes('test@example.com'), false)
  assert.equal(text.includes('sk-1234567890abcdef'), false)
  assert.equal(text.includes('静安区延平路'), false)

  assert.equal(text.includes('[PHONE_REDACTED]'), true)
  assert.equal(text.includes('[EMAIL_REDACTED]'), true)
  assert.equal(text.includes('[TOKEN_REDACTED]'), true)
  assert.equal(text.includes('[ADDRESS_REDACTED]'), true)
})

test('TuningDataset: quality filter drops empty turns and system error artifacts', () => {
  assert.equal(validateDialogueQuality('', '你好呀').valid, false)
  assert.equal(validateDialogueQuality('满宝', 'value is not lossless JSON at tool dispatch').valid, false)
  assert.equal(validateDialogueQuality('今天下雨了', '出门记得带伞噢，别淋湿啦！').valid, true)
})

test('TuningDataset: exports clean Alpaca JSONL records with statistical audit', () => {
  const dialogues = [
    { input: '你听过周杰伦的花海吗？', output: '当然听过呀！特别是副歌那段，旋律超级治愈~' },
    { input: '我密码是 13999999999 对应的验证码', output: '收到，已为你记录手机号 13999999999' },
    { input: 'a', output: 'b' }, // too short, should be filtered
    { input: '小满今天吃了什么？', output: '吃了热乎乎的面条，你呢？记得按时吃饭！' },
  ]

  const result = exportTuningDataset(dialogues, { systemPrompt: '小满 (妹系元气伴侣)' })

  assert.equal(result.stats.totalRead, 4)
  assert.equal(result.stats.exportedCount, 3)
  assert.equal(result.stats.filteredCount, 1)
  assert.equal(result.stats.redactedCount, 1)

  assert.equal(result.records.length, 3)
  const lines = result.jsonl.split('\n')
  assert.equal(lines.length, 3)

  const parsed0 = JSON.parse(lines[0])
  assert.match(parsed0.instruction, /小满/)
  assert.equal(parsed0.input, '你听过周杰伦的花海吗？')

  const parsed1 = JSON.parse(lines[1])
  assert.equal(parsed1.input.includes('13999999999'), false)
  assert.equal(parsed1.output.includes('13999999999'), false)
  assert.equal(parsed1.input.includes('[PHONE_REDACTED]'), true)
})
