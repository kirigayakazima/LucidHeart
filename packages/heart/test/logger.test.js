import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  log,
  logEvent,
  readModuleLogs,
  LOG_MODULES,
  LOG_LEVELS,
  LOGS_DIR,
  MAX_LOG_SIZE_BYTES,
  sanitizeLogData,
} from '../lib/logger.js'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heart-logger-test-'))
}

// ---------------------------------------------------------------- 1. 分区落盘与文件路径正确性
test('1. logger 分区落盘：各模块日志独立写入对应文件', () => {
  const root = tmp()

  log.core(root, 'info', 'plugin_init', { version: '0.17.0' })
  log.mood(root, 'info', 'update_mood', { state: 'cheerful', intensity: 0.7 })
  log.dream(root, 'info', 'save_insight', { id: 'abc12345' })
  log.memory(root, 'info', 'append_fact', { statement: '用户喜欢简洁回答' })
  log.store(root, 'warn', 'lock_timeout', { lock: 'mood.json.lock' })

  const logsDir = path.join(root, LOGS_DIR)
  assert.equal(fs.existsSync(path.join(logsDir, 'core.log')), true)
  assert.equal(fs.existsSync(path.join(logsDir, 'mood.log')), true)
  assert.equal(fs.existsSync(path.join(logsDir, 'dream.log')), true)
  assert.equal(fs.existsSync(path.join(logsDir, 'memory.log')), true)
  assert.equal(fs.existsSync(path.join(logsDir, 'store.log')), true)

  // 未知模块安全降级到 core
  logEvent(root, 'unknown_module', 'info', 'fallback_test')
  const coreLogs = readModuleLogs(root, 'core')
  assert.ok(coreLogs.some((l) => l.action === 'fallback_test'))
})

// ---------------------------------------------------------------- 2. 结构化 JSONL 与字段契约
test('2. logger 格式与字段契约：有效 JSONL、包含时间戳、级别、模块、结果与摘要', () => {
  const root = tmp()
  const t0 = new Date('2026-10-28T12:00:00.000Z')

  log.dream(
    root,
    'info',
    'confirm_insight',
    {
      id: 'insight-64-char-hash-sample-1234567890abcdef',
      result: 'confirmed',
      detail: { category: 'workflow', statement: '习惯先看测试结果' },
    },
    t0
  )

  const logs = readModuleLogs(root, 'dream')
  assert.equal(logs.length, 1)
  const entry = logs[0]
  assert.equal(entry.ts, '2026-10-28T12:00:00.000Z')
  assert.equal(entry.level, 'info')
  assert.equal(entry.module, 'dream')
  assert.equal(entry.action, 'confirm_insight')
  assert.equal(entry.result, 'confirmed')
  assert.equal(entry.id, 'insight-64-char-hash-sample-1234567890abcdef')
  assert.equal(entry.detail.category, 'workflow')
})

// ---------------------------------------------------------------- 3. 有界日志管理与文件轮转
test('3. logger 有界管理：单文件超出阈值自动轮转为 .old，杜绝无限膨胀', () => {
  const root = tmp()
  const logsDir = path.join(root, LOGS_DIR)
  fs.mkdirSync(logsDir, { recursive: true })
  const coreLog = path.join(logsDir, 'core.log')

  // 构造接近并超过 512KB 的日志文件
  const chunk = '{"ts":"2026-10-28T00:00:00.000Z","level":"info","module":"core","action":"dummy","result":"ok"}\n'
  const count = Math.ceil((MAX_LOG_SIZE_BYTES + 2048) / chunk.length)
  fs.writeFileSync(coreLog, chunk.repeat(count), 'utf8')

  assert.ok(fs.statSync(coreLog).size >= MAX_LOG_SIZE_BYTES)

  // 再次写入一条，触发轮转
  log.core(root, 'info', 'after_rotate_action')

  // 原文件已被重命名为 .old，新文件体积恢复小体积
  const oldLog = path.join(logsDir, 'core.log.old')
  assert.equal(fs.existsSync(oldLog), true)
  assert.ok(fs.statSync(oldLog).size >= MAX_LOG_SIZE_BYTES)

  const newLogSize = fs.statSync(coreLog).size
  assert.ok(newLogSize < 1024)

  const latestLogs = readModuleLogs(root, 'core')
  assert.equal(latestLogs[latestLogs.length - 1].action, 'after_rotate_action')
})

// ---------------------------------------------------------------- 4. 敏感数据脱敏与长文本截断
test('4. logger 数据脱敏与保护：密码/Token 脱敏，超长字符串截断', () => {
  const sanitized = sanitizeLogData({
    normalField: 'hello',
    password: 'super-secret-password-123',
    apiKey: 'sk-123456789',
    authToken: 'bearer-xyz',
    longText: 'A'.repeat(500),
  })

  assert.equal(sanitized.normalField, 'hello')
  assert.equal(sanitized.password, '[REDACTED]')
  assert.equal(sanitized.apiKey, '[REDACTED]')
  assert.equal(sanitized.authToken, '[REDACTED]')
  assert.ok(sanitized.longText.includes('[截断]'))
  assert.ok(sanitized.longText.length <= 320)
})

// ---------------------------------------------------------------- 5. 绝对高可用性与零阻断保护
test('5. logger 容错安全：路径异常或权限失败绝不抛出异常阻断业务', () => {
  // 传入一个非法或只读的伪根路径（模拟 I/O 故障）
  const fakeRoot = path.join(tmp(), 'file-not-a-dir')
  fs.writeFileSync(fakeRoot, 'blocker') // 创建同名文件使 mkdirSync 失败

  // 调用 logEvent，绝不抛出任何异常
  assert.doesNotThrow(() => {
    const res = log.mood(fakeRoot, 'error', 'failed_mood_test')
    assert.equal(res.ok, false)
  })
})
