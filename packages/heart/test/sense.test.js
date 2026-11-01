import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyPresence,
  computeRawPresence,
  formatSenseLine,
  readSense,
  writeSense,
  appendSenseLog,
  readSenseLog,
  toLocalISOString,
  SENSE_LOG_MAX,
} from '../lib/sense.js'
import { sampleWin } from '../lib/sense-win.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-sense-test-'))

test('computeRawPresence：状态判定优先级', () => {
  // 1. 安静时段 -> asleep
  const night = new Date('2026-10-21T23:30:00')
  assert.equal(
    computeRawPresence({ idleMs: 0, sinceMsgMin: 0 }, { now: night, quietFrom: '23:00', quietTo: '08:00' }),
    'asleep'
  )

  const day = new Date('2026-10-21T14:00:00')

  // 2. idleMs <= 120s 或 sinceMsgMin <= 5 -> present
  assert.equal(
    computeRawPresence({ idleMs: 30000, sinceMsgMin: 10 }, { now: day }),
    'present'
  )
  assert.equal(
    computeRawPresence({ idleMs: 200000, sinceMsgMin: 3 }, { now: day }),
    'present'
  )

  // 3. sinceMsgMin <= awayMinutes (30) -> nearby
  assert.equal(
    computeRawPresence({ idleMs: 300000, sinceMsgMin: 20 }, { now: day, awayMinutes: 30 }),
    'nearby'
  )

  // 4. 其余 -> away
  assert.equal(
    computeRawPresence({ idleMs: 300000, sinceMsgMin: 45 }, { now: day, awayMinutes: 30 }),
    'away'
  )
})

test('applyPresence：去抖机制避免单次波动', () => {
  const day = new Date('2026-10-21T14:00:00')
  const prevConfirmed = {
    at: '2026-10-21T14:00:00+08:00',
    presence: 'present',
    rawPresence: 'present',
  }

  // 第一次采样为 away：不切换，保留 present
  const sampleAway1 = {
    at: '2026-10-21T14:01:00+08:00',
    idleMs: 500000,
    sinceMsgMin: 40,
  }
  const next1 = applyPresence(prevConfirmed, sampleAway1, { awayMinutes: 30 }, { now: day })
  assert.equal(next1.presence, 'present')
  assert.equal(next1.rawPresence, 'away')

  // 第二次连续采样为 away：确认切换至 away，并记录离开起点 awaySince
  const sampleAway2 = {
    at: '2026-10-21T14:02:00+08:00',
    idleMs: 560000,
    sinceMsgMin: 41,
  }
  const next2 = applyPresence(next1, sampleAway2, { awayMinutes: 30 }, { now: day })
  assert.equal(next2.presence, 'away')
  assert.equal(next2.rawPresence, 'away')
  assert.equal(next2.awaySince, '2026-10-21T14:02:00+08:00')

  // 保持 away：awaySince 保留最早起点
  const sampleAway3 = {
    at: '2026-10-21T14:03:00+08:00',
    idleMs: 620000,
    sinceMsgMin: 42,
  }
  const next3 = applyPresence(next2, sampleAway3, { awayMinutes: 30 }, { now: day })
  assert.equal(next3.presence, 'away')
  assert.equal(next3.awaySince, '2026-10-21T14:02:00+08:00')

  // 回到 present：awaySince 清空
  const samplePresent = {
    at: '2026-10-21T14:04:00+08:00',
    idleMs: 0,
    sinceMsgMin: 0,
  }
  // 模拟去抖后确认进入 present
  const next4 = applyPresence({ ...next3, rawPresence: 'present' }, samplePresent, { awayMinutes: 30 }, { now: day })
  assert.equal(next4.presence, 'present')
  assert.equal(next4.awaySince, null)
})

test('applyPresence：PowerShell 采样失败不误判离开', () => {
  const prev = {
    at: '2026-10-21T14:00:00+08:00',
    presence: 'present',
    rawPresence: 'present',
  }
  const failedSample = {
    at: '2026-10-21T14:01:00+08:00',
    idleMs: null,
    fg: null,
    sinceMsgMin: 20,
    error: 'powershell-timeout',
  }
  const next = applyPresence(prev, failedSample)
  assert.equal(next.presence, 'present')
  assert.equal(next.error, 'powershell-timeout')
})

test('applyPresence：进程启动时记录原始状态', () => {
  const sample = {
    at: '2026-10-21T14:00:00+08:00',
    idleMs: 1000,
    sinceMsgMin: 1,
  }
  const next = applyPresence(null, sample)
  assert.equal(next.presence, 'present')
  assert.equal(next.rawPresence, 'present')
})

test('applyPresence：重启首拍丢弃旧的 away 状态，避免隔天误触发', () => {
  const stale = {
    presence: 'away',
    rawPresence: 'away',
    at: '2026-10-19T10:00:00+08:00',
    awaySince: '2026-10-19T09:00:00+08:00',
  }
  const sample = { at: '2026-10-21T20:00:00+08:00', idleMs: 1000, sinceMsgMin: 0 }
  const next = applyPresence(stale, sample, {}, { isStartup: true })
  assert.equal(next.presence, 'present')
  assert.equal(next.awaySince, null)

  const second = applyPresence(next, { ...sample, at: '2026-10-21T20:01:00+08:00' }, {})
  assert.equal(second.presence, 'present')
  assert.equal(second.awaySince, null)
})

test('formatSenseLine：输出格式稳定，错误行包含 error 字段', () => {
  const normal = {
    at: '2026-10-21T19:20:00+08:00',
    presence: 'present',
    idleMs: 41000,
    sinceMsgMin: 0,
    fg: 'DeepSeek Harness',
  }
  const line1 = formatSenseLine(normal)
  assert.ok(line1.includes('|presence=present|idle=41s|sinceMsg=0m|fg=DeepSeek Harness'))

  const errorRow = {
    at: '2026-10-21T19:22:00+08:00',
    presence: 'present',
    idleMs: 0,
    sinceMsgMin: 0,
    error: 'powershell-timeout',
  }
  const line2 = formatSenseLine(errorRow)
  assert.ok(line2.includes('|presence=present|idle=0s|sinceMsg=0m|error=powershell-timeout'))
})

test('sense.json 原子写入与读取', () => {
  const root = tmp()
  assert.equal(readSense(root), null)

  const record = {
    at: toLocalISOString(new Date()),
    presence: 'present',
    idleMs: 12000,
    fg: 'test-app',
    sinceMsgMin: 2,
    screen: null,
    net: null,
    battery: null,
    error: null,
  }
  writeSense(root, record)
  const readBack = readSense(root)
  assert.deepEqual(readBack, record)
})

test('sense.log 环形日志不超过指定行数', () => {
  const root = tmp()
  const file = path.join(root, 'sense.log')
  // 填充超过上限的行
  fs.writeFileSync(
    file,
    Array.from({ length: SENSE_LOG_MAX + 10 }, (_, i) => `2026-10-21 12:00:00|presence=present|idle=${i}s`).join('\n') + '\n',
    'utf8'
  )

  const record = {
    at: '2026-10-21T19:20:00+08:00',
    presence: 'present',
    idleMs: 5000,
    sinceMsgMin: 1,
    fg: 'editor',
  }
  appendSenseLog(root, record, { senseLogMax: SENSE_LOG_MAX })
  const lines = readSenseLog(root, { limit: 1000 })
  assert.equal(lines.length, SENSE_LOG_MAX)
  assert.ok(lines[lines.length - 1].includes('idle=5s'))
})

test('sampleWin 支持 runner 注入测试', async () => {
  const custom = await sampleWin({
    runner: ({ at, sinceMsgMin }) => ({
      at: toLocalISOString(at),
      idleMs: 1500,
      fg: 'Test Runner',
      sinceMsgMin: sinceMsgMin ?? 0,
      screen: null,
      net: null,
      battery: null,
      error: null,
    }),
  })
  assert.equal(custom.idleMs, 1500)
  assert.equal(custom.fg, 'Test Runner')
})
