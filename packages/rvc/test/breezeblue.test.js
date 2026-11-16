import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  resolveVoiceInstructions,
  synthesizeBreezeVoice,
  archiveToDataset,
  DEFAULT_BREEZE_VOICE_ID,
} from '../lib/breezeblue.js'
import { runSpeak } from '../lib/runner.js'

test('BreezeBlue Voice Engine & Dataset Harvester', async (t) => {
  await t.test('resolveVoiceInstructions: 规则化情境与情绪映射 (零额外 LLM 调用)', () => {
    // 1. 晚安/困倦语义
    const nightInst = resolveVoiceInstructions('哥哥晚安，早点睡哦～', {}, {}, { hour: 20 })
    assert.match(nightInst, /低柔温和/, '晚安语义应触发耳边轻声夜谈')

    // 2. 安慰/同理心/疲惫
    const comfortInst = resolveVoiceInstructions('今天辛苦啦，抱抱你，别难过', {}, {}, { hour: 14 })
    assert.match(comfortInst, /声音放轻放柔/, '安慰疲惫语义应触发温和倾听')

    const tiredInst = resolveVoiceInstructions('今天做了好多事情', { emotion: 'tired' }, {}, { hour: 14 })
    assert.match(tiredInst, /声音放轻放柔/, 'tired 心情应触发温和倾听')

    // 3. 玩笑/吐槽/游戏互动
    const playfulInst = resolveVoiceInstructions('哈哈才怪呢，输了可别赖我！', {}, {}, { hour: 14 })
    assert.match(playfulInst, /略带忍不住的轻笑/, '调侃玩笑应触发带轻笑的俏皮语气')

    // 4. 惊喜/庆祝/开怀
    const joyInst = resolveVoiceInstructions('太棒啦！好耶，我们成功啦！', {}, { state: 'joy' }, { hour: 14 })
    assert.match(joyInst, /由衷的开心/, '开怀庆祝应触发由衷开心的少女音')

    // 5. 认真技术说明/排查
    const techInst = resolveVoiceInstructions('我来看看报错日志和代码配置，排查一下原因', {}, {}, { hour: 14 })
    assert.match(techInst, /清晰自然客观/, '技术排查应触发清晰客观语调')

    // 6. 深夜时段保护 (无特定强烈情绪时自动轻柔)
    const lateInst = resolveVoiceInstructions('你在干嘛呢', {}, {}, { hour: 23 })
    assert.match(lateInst, /低柔温和/, '深夜时段自动进入低柔夜谈')

    // 7. 日常默认交谈
    const defaultInst = resolveVoiceInstructions('今天天气真不错，中午吃鸡翅吗', {}, {}, { hour: 12 })
    assert.match(defaultInst, /自然清亮的少女音/, '日常闲聊使用自然清亮少女音')
  })

  await t.test('archiveToDataset: 自动沉淀音频与标注文本至手机训练集目录', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dataset-test-'))
    try {
      const dummyAudio = Buffer.from('FAKE_MP3_DATA_1234567890')
      const text = '鸡翅记得先腌上，别光顾着打游戏忘了时间。'
      const instructions = '略带忍不住的轻笑，俏皮灵动但不尖细。'

      const savedPath = archiveToDataset({
        datasetDir: tmpDir,
        text,
        instructions,
        audioBuffer: dummyAudio,
        voiceId: DEFAULT_BREEZE_VOICE_ID,
        ext: '.mp3',
      })

      assert.ok(savedPath, '应成功返回持久化文件绝对路径')
      assert.ok(fs.existsSync(savedPath), '归档音频文件必须真实存在')
      assert.equal(fs.readFileSync(savedPath).toString(), 'FAKE_MP3_DATA_1234567890')

      // 验证 manifest 标注清单
      const manifestPath = path.join(tmpDir, 'dataset.jsonl')
      assert.ok(fs.existsSync(manifestPath), 'dataset.jsonl 必须被生成')
      const lines = fs.readFileSync(manifestPath, 'utf8').trim().split('\n')
      assert.equal(lines.length, 1)

      const entry = JSON.parse(lines[0])
      assert.ok(entry.id.startsWith('ds_'))
      assert.equal(entry.text, text)
      assert.equal(entry.instructions, instructions)
      assert.equal(entry.voiceId, DEFAULT_BREEZE_VOICE_ID)
      assert.equal(entry.bytes, dummyAudio.length)
      assert.match(entry.audioFile, /^audio\/xiaoman_.*\.mp3$/)

      // 测试异常防护：空数据安全返回 null
      assert.equal(archiveToDataset({ datasetDir: tmpDir, text: '', audioBuffer: null }), null)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await t.test('synthesizeBreezeVoice: API 协议、参数校验与 Mock 合成', async () => {
    // 1. 空文本校验
    await assert.rejects(
      synthesizeBreezeVoice({ text: '', apiKey: 'dummy_key' }),
      /text cannot be empty/
    )

    // 2. 缺失 API Key 校验
    await assert.rejects(
      synthesizeBreezeVoice({ text: '你好呀', apiKey: '' }),
      /apiKey is required/
    )

    // 3. 模拟正常 API 响应
    const originalFetch = globalThis.fetch
    try {
      let capturedUrl = ''
      let capturedHeaders = {}
      let capturedBody = null

      globalThis.fetch = async (url, opts) => {
        capturedUrl = String(url)
        capturedHeaders = opts.headers
        capturedBody = JSON.parse(opts.body)
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from('MOCK_BREEZE_MP3_STREAM'),
        }
      }

      const audio = await synthesizeBreezeVoice({
        text: '你好呀哥哥！',
        apiKey: 'test_api_key_123',
        voiceId: 'voc_myarmcyqm2zv',
      })

      assert.ok(Buffer.isBuffer(audio))
      assert.equal(audio.toString(), 'MOCK_BREEZE_MP3_STREAM')
      assert.equal(capturedUrl, 'https://api.breeze.blue/v1/text-to-speech/voc_myarmcyqm2zv?output_format=mp3')
      assert.equal(capturedHeaders['xi-api-key'], 'test_api_key_123')
      assert.equal(capturedBody.text, '你好呀哥哥！')
      assert.equal(capturedBody.voice_settings.guidance_scale, 2)
      assert.ok(capturedBody.instructions.length > 0)

      // 4. 模拟 API 报错 (例如 HTTP 401 或 500)
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Invalid API Key',
      })

      await assert.rejects(
        synthesizeBreezeVoice({
          text: '测试错误',
          apiKey: 'wrong_key',
        }),
        /BreezeBlue API HTTP 401: Invalid API Key/
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await t.test('runSpeak: Breezeblue 端到端合成、文件归档与模式标记', async () => {
    const originalFetch = globalThis.fetch
    const tmpDatasetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-speak-dataset-'))
    const tmpOut = path.join(os.tmpdir(), `test_speak_${Date.now()}.mp3`)

    try {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from('TEST_RUN_SPEAK_AUDIO_DATA'),
      })

      const res = await runSpeak({
        text: '小满今天也很想你哦！',
        provider: 'breezeblue',
        breezeApiKey: 'mock_key',
        breezeVoiceId: 'voc_myarmcyqm2zv',
        saveDataset: true,
        datasetDir: tmpDatasetDir,
        outWav: tmpOut,
      })

      assert.equal(res.ok, true)
      assert.equal(res.mode, 'breezeblue_online')
      assert.equal(res.voiceId, 'voc_myarmcyqm2zv')
      assert.ok(res.audioPath.endsWith('.mp3'))
      assert.ok(fs.existsSync(res.audioPath))
      assert.equal(fs.readFileSync(res.audioPath).toString(), 'TEST_RUN_SPEAK_AUDIO_DATA')

      // 验证自动入库
      assert.ok(res.datasetPath)
      assert.ok(fs.existsSync(res.datasetPath))
      assert.ok(fs.existsSync(path.join(tmpDatasetDir, 'dataset.jsonl')))
    } finally {
      globalThis.fetch = originalFetch
      fs.rmSync(tmpDatasetDir, { recursive: true, force: true })
      if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut)
    }
  })
})
