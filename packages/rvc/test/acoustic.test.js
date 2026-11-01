import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { computeAcousticProfile, VALID_PITCHES } from '../lib/acoustic.js'

describe('Acoustic Parameters & Heart Mood Mapping', () => {
  test('元气少女态 (Joy / Arousal 0.8) 映射为 P0 (pitch 0, 255Hz) 与清脆高频', () => {
    const mood = {
      state: 'joy',
      arousal: 0.8,
      valence: 0.6,
      energy: 0.9,
    }
    const profile = computeAcousticProfile(mood)
    assert.equal(profile.pitch, 0)
    assert.equal(profile.brightness, 2.8)
    assert.equal(profile.rate, '+6%')
    assert.equal(profile.protect, 0.33)
    assert.match(profile.pitchName, /P0/)
  })

  test('沉稳日常态 (Calm / Arousal 0.35) 映射为 P4 (pitch -4, 210Hz) 与平稳语速', () => {
    const mood = {
      state: 'calm',
      arousal: 0.35,
      valence: 0.2,
      energy: 0.6,
    }
    const profile = computeAcousticProfile(mood)
    assert.equal(profile.pitch, -4)
    assert.equal(profile.brightness, 2.5)
    assert.equal(profile.rate, '+0%')
    assert.match(profile.pitchName, /P4/)
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
    assert.equal(profile.brightness, 2.0)
    assert.equal(profile.rate, '-8%')
  })

  test('★ 关键安全防线：拦截 -2 非法音高 (防八度跳变)，自动校正为 -4', () => {
    const mood = { state: 'calm', arousal: 0.4 }
    // 模拟用户或模型误传 -2
    const profile = computeAcousticProfile(mood, { pitch: -2 })
    assert.equal(profile.pitch, -4, '必须安全校正为 -4，绝不能产生 -2 八度跳变破音')
  })

  test('显式选项优先级高于情绪快照', () => {
    const mood = { state: 'calm', arousal: 0.2 }
    const profile = computeAcousticProfile(mood, { pitch: 0, brightness: 3.0, rate: '+10%' })
    assert.equal(profile.pitch, 0)
    assert.equal(profile.brightness, 3.0)
    assert.equal(profile.rate, '+10%')
  })
})
