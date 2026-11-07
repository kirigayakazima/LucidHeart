import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeAcousticProfile, VALID_PITCHES, planVoiceChunks, joinVoiceChunks } from '../lib/acoustic.js'

describe('Acoustic Parameters & Heart Mood Mapping', () => {
  test('高正向唤醒度映射为 P0 和 +4% 语速', () => {
    const mood = {
      state: 'cheerful',
      arousal: 0.8,
      valence: 0.6,
      energy: 0.9,
    }
    const profile = computeAcousticProfile(mood)
    assert.equal(profile.pitch, 0)
    assert.equal(profile.brightness, 2.2)
    assert.equal(profile.rate, '+4%')
    assert.equal(profile.protect, 0.33)
    assert.match(profile.pitchName, /P0/)
  })

  test('默认心境使用晓晓、P4、+0% 语速，参数可无损往返 JSON', () => {
    const profile = computeAcousticProfile()
    assert.equal(profile.ttsVoice, 'zh-CN-XiaoxiaoNeural')
    assert.equal(profile.pitch, -4)
    assert.equal(profile.brightness, 2.2)
    assert.equal(profile.rate, '+0%')
    assert.match(profile.pitchName, /P4/)
    assert.deepEqual(profile, JSON.parse(JSON.stringify(profile)))
    const invalid = computeAcousticProfile({ valence: NaN, arousal: Infinity, energy: -Infinity }, { brightness: NaN })
    assert.deepEqual(invalid, profile)
  })

  test('升至 P0 需同时达到情绪阈值，或为指定的正向情绪', () => {
    assert.equal(computeAcousticProfile({ valence: 0.5, arousal: 0.65 }).pitch, 0)
    assert.equal(computeAcousticProfile({ valence: 0.49, arousal: 0.8 }).pitch, -4)
    assert.equal(computeAcousticProfile({ valence: 0.8, arousal: 0.64 }).pitch, -4)
    assert.equal(computeAcousticProfile({ state: 'curious', arousal: 0.6 }).pitch, -4)
    for (const state of ['joy', 'excited', 'happy']) {
      assert.equal(computeAcousticProfile({ state }).pitch, 0)
      assert.equal(computeAcousticProfile({ state }, { pitch: -4 }).pitch, -4)
    }
  })

  test('疲惫慵懒态 (Sleepy / Energy 0.2) 映射为 P4 与柔和低通补偿', () => {
    const mood = {
      state: 'sleepy',
      arousal: 0.2,
      valence: 0.1,
      energy: 0.2,
    }
    const profile = computeAcousticProfile(mood)
    assert.equal(profile.pitch, -4)
    assert.equal(profile.brightness, 1.8)
    assert.equal(profile.rate, '-6%')
    assert.equal(computeAcousticProfile({ state: 'neutral', energy: 0.39, arousal: 0.8 }).rate, '-6%')
  })

  test('★ 关键安全防线：拦截 -2 非法音高 (防八度跳变)，自动校正为 -4', () => {
    const mood = { state: 'excited', arousal: 0.8 }
    // 模拟用户或模型误传 -2
    const profile = computeAcousticProfile(mood, { pitch: -2 })
    assert.equal(profile.pitch, -4, '必须安全校正为 -4，绝不能产生 -2 八度跳变破音')
    assert.equal(computeAcousticProfile(mood, { pitch: 1 }).pitch, -4)
  })

  test('显式选项优先级高于情绪快照', () => {
    const mood = { state: 'calm', arousal: 0.2 }
    const profile = computeAcousticProfile(mood, { pitch: 0, brightness: 3.0, rate: '+10%' })
    assert.equal(profile.pitch, 0)
    assert.equal(profile.brightness, 3.0)
    assert.equal(profile.rate, '+10%')
  })
})

test('按真实时长启用切分，有标点的静音优先于较晚的其他静音', () => {
  const dry = new Int16Array(16_000 * 13 + 3).fill(1500)
  for (const second of [4, 6, 9]) dry.fill(0, second * 16_000, second * 16_000 + 3200)
  assert.equal(planVoiceChunks(dry.subarray(0, 16_000 * 10)).length, 1)
  const spans = planVoiceChunks(dry, [4, 9])
  assert.equal(spans[0].end, 65_600)
  assert.equal(spans[1].start, spans[0].end)
  assert.equal(spans.at(-1).end, dry.length)
  assert.equal(planVoiceChunks(dry)[0].end, 97_600)
})

test('Hann 叠加保留总样本数、边界幅度和尾部', () => {
  const dry = new Int16Array(16_000 * 12 + 3).fill(1000)
  const spans = planVoiceChunks(dry)
  assert.equal(spans.length, 2)
  const samples = spans.map(({ contextStart, contextEnd }, i) =>
    new Int16Array(Math.round(contextEnd * 2.5) - Math.round(contextStart * 2.5)).fill(i === 0 ? 1000 : 3000))
  const joined = joinVoiceChunks(spans, samples)
  const join = Math.round(spans[0].end * 2.5)
  assert.equal(joined.length, Math.round(dry.length * 2.5))
  assert.equal(joined[0], 1000)
  assert.equal(joined.at(-1), 3000)
  assert.equal(joined[join - 2000], 1000)
  assert.equal(joined[join - 1000], 1293)
  assert.equal(joined[join + 1000], 2708)
  assert.equal(joined[join + 1999], 3000)
  assert.ok(Math.abs(joined[join] - 2000) < 3)
  assert.ok(Math.abs(joined[join] - joined[join - 1]) < 5)
  assert.throws(() => joinVoiceChunks(spans, [samples[0], new Int16Array(2)]), /lost samples/)
})
