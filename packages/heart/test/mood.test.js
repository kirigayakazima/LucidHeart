import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  readMood,
  readPersistedMood,
  updateMood,
  resetMood,
  getEffectiveMood,
  isValidPersistedMood,
  calculateDecayedIntensity,
  validateMoodCandidate,
  shouldUpdateMood,
  createDefaultMood,
  formatMoodPrompt,
  MOOD_STATES,
  MOOD_REASONS,
  STATE_REASON_MATRIX,
  LOW_INTENSITY_THRESHOLD,
  DEFAULT_HALF_LIFE_MS,
  MOOD_FILE,
  acquireDirLock,
  releaseDirLock,
  BASELINE,
  HALF_LIFE_MS,
  decayDimension,
  calculateDistanceToBaseline,
  deriveDominantState,
  mapStateTo3DImpulse,
  format3DMoodPrompt,
} from '../lib/store.js'
import { buildMoodSection } from '../lib/prompt.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-mood-test-'))

// ---------------------------------------------------------------- 1. 纯数学与指数衰减纯函数
test('1. calculateDecayedIntensity 纯数学衰减精度与边界验证', () => {
  const H = 2 * 3600 * 1000 // 2小时

  // 0 时间衰减：强度不变
  assert.equal(calculateDecayedIntensity(0.8, 0, H), 0.8)

  // 1 个半衰期：折半 (0.8 -> 0.4)
  const i1 = calculateDecayedIntensity(0.8, H, H)
  assert.ok(Math.abs(i1 - 0.4) < 1e-6)

  // 2 个半衰期：折半再折半 (0.8 -> 0.2)
  const i2 = calculateDecayedIntensity(0.8, 2 * H, H)
  assert.ok(Math.abs(i2 - 0.2) < 1e-6)

  // 时间倒退（负时间差）：时钟倒退防御，强制按 0 处理，绝不放大强度
  const iNegative = calculateDecayedIntensity(0.8, -3600 * 1000, H)
  assert.equal(iNegative, 0.8)

  // 非法或边界输入
  assert.equal(calculateDecayedIntensity(0, 1000, H), 0)
  assert.equal(calculateDecayedIntensity(-0.5, 1000, H), 0)
  assert.equal(calculateDecayedIntensity(NaN, 1000, H), 0)
})

test('2. getEffectiveMood 惰性有效状态计算与阈值回归 calm', () => {
  const t0 = new Date('2026-10-26T10:00:00.000Z')
  const H = 2 * 3600 * 1000

  const persisted = {
    schemaVersion: 1,
    state: 'cheerful',
    intensity: 0.8,
    updatedAt: t0.toISOString(),
    reason: 'task_completed',
  }

  // 经过 2 小时：0.8 -> 0.4 (仍 > 0.15 阈值，保持 cheerful)
  const t1 = new Date(t0.getTime() + H)
  const eff1 = getEffectiveMood(persisted, t1, { halfLifeMs: H })
  assert.equal(eff1.state, 'cheerful')
  assert.equal(eff1.intensity, 0.4)

  // 经过 4 小时：0.8 -> 0.2 (仍 > 0.15 阈值，保持 cheerful)
  const t2 = new Date(t0.getTime() + 2 * H)
  const eff2 = getEffectiveMood(persisted, t2, { halfLifeMs: H })
  assert.equal(eff2.state, 'cheerful')
  assert.equal(eff2.intensity, 0.2)

  // 经过 5.5 小时：0.8 * 2^(-2.75) ≈ 0.119 <= 0.15 (自动回归 calm，强度归零)
  const t3 = new Date(t0.getTime() + 5.5 * 3600 * 1000)
  const eff3 = getEffectiveMood(persisted, t3, { halfLifeMs: H })
  assert.equal(eff3.state, 'calm')
  assert.equal(eff3.intensity, 0.0)

  // calm 状态无论原始强度是多少，规范化后强度均必须为 0.0
  const calmPersisted = {
    schemaVersion: 1,
    state: 'calm',
    intensity: 0.5, // 语义冲突脏数据
    updatedAt: t0.toISOString(),
    reason: 'baseline',
  }
  const effCalm = getEffectiveMood(calmPersisted, t0)
  assert.equal(effCalm.state, 'calm')
  assert.equal(effCalm.intensity, 0.0)
})

// ---------------------------------------------------------------- 2. 候选状态基础校验与状态转移约束
test('3. validateMoodCandidate 校验合法性与非法拦截', () => {
  // 合法用例
  assert.equal(validateMoodCandidate({ state: 'calm', intensity: 0, reason: 'baseline' }).ok, true)
  assert.equal(validateMoodCandidate({ state: 'engaged', intensity: 0.6, reason: 'focus' }).ok, true)
  assert.equal(validateMoodCandidate({ state: 'cheerful', intensity: 0.8, reason: 'task_completed' }).ok, true)

  // 非法状态
  assert.equal(validateMoodCandidate({ state: 'angry', intensity: 0.5, reason: 'focus' }).reason, 'invalid-state')
  assert.equal(validateMoodCandidate({ state: 'sad', intensity: 0.5, reason: 'focus' }).reason, 'invalid-state')

  // 非法强度
  assert.equal(validateMoodCandidate({ state: 'calm', intensity: -0.1, reason: 'baseline' }).reason, 'invalid-intensity')
  assert.equal(validateMoodCandidate({ state: 'calm', intensity: 1.5, reason: 'baseline' }).reason, 'invalid-intensity')
  assert.equal(validateMoodCandidate({ state: 'calm', intensity: NaN, reason: 'baseline' }).reason, 'invalid-intensity')
  assert.equal(validateMoodCandidate({ state: 'calm', intensity: 'high', reason: 'baseline' }).reason, 'invalid-intensity')

  // 非法原因
  assert.equal(validateMoodCandidate({ state: 'calm', intensity: 0, reason: 'arbitrary_guess' }).reason, 'invalid-reason')
})

test('4. shouldUpdateMood 状态转移规则与 Reason 映射矩阵约束', () => {
  const current = createDefaultMood()

  // 1. baseline 严禁作为触发 excited/cheerful 的通行证（仅限 calm）
  const rBaselineExcited = shouldUpdateMood(current, { state: 'excited', intensity: 0.8, reason: 'baseline' })
  assert.equal(rBaselineExcited.ok, false)
  assert.equal(rBaselineExcited.reason, 'state-reason-mismatch')

  // 2. focus 仅允许触发 engaged，不能触发 cheerful
  const rFocusCheerful = shouldUpdateMood(current, { state: 'cheerful', intensity: 0.7, reason: 'focus' })
  assert.equal(rFocusCheerful.ok, false)
  assert.equal(rFocusCheerful.reason, 'state-reason-mismatch')

  // 3. task_completed 允许触发 excited，但有细分约束（强度 >= 0.7）
  const rTaskLowExcited = shouldUpdateMood(current, { state: 'excited', intensity: 0.5, reason: 'task_completed' })
  assert.equal(rTaskLowExcited.ok, false)
  assert.equal(rTaskLowExcited.reason, 'intensity-too-low-for-state')

  // 4. deep_work 仅用于持续高负荷工作后的低活跃过渡，且严格只允许 tired（强度 0.2 ~ 0.6）
  const rDeepWorkValid = shouldUpdateMood(current, { state: 'tired', intensity: 0.5, reason: 'deep_work' })
  assert.equal(rDeepWorkValid.ok, true)
  const rDeepWorkInvalidState = shouldUpdateMood(current, { state: 'cheerful', intensity: 0.5, reason: 'deep_work' })
  assert.equal(rDeepWorkInvalidState.ok, false)
  assert.equal(rDeepWorkInvalidState.reason, 'state-reason-mismatch')
  // deep_work 不允许触发 calm（回归 calm 由时间自然衰减或显式 baseline 负责）
  const rDeepWorkCalm = shouldUpdateMood(current, { state: 'calm', intensity: 0.0, reason: 'deep_work' })
  assert.equal(rDeepWorkCalm.ok, false)
  assert.equal(rDeepWorkCalm.reason, 'state-reason-mismatch')

  // 5. 微小强度变化抑制（与当前【有效状态】对比）
  const activeEffective = {
    schemaVersion: 1,
    state: 'engaged',
    intensity: 0.60,
    updatedAt: new Date().toISOString(),
    reason: 'focus',
  }
  // 相同状态、相同原因，强度从 0.60 变成 0.62 (|ΔI| = 0.02 < 0.05)：无显著新事件，拦截写盘
  const rMicro = shouldUpdateMood(activeEffective, { state: 'engaged', intensity: 0.62, reason: 'focus' })
  assert.equal(rMicro.ok, false)
  assert.equal(rMicro.reason, 'no-significant-change')

  // 显著变化 (0.60 -> 0.75, |ΔI| = 0.15 >= 0.05)：允许写盘
  const rSignificant = shouldUpdateMood(activeEffective, { state: 'engaged', intensity: 0.75, reason: 'focus' })
  assert.equal(rSignificant.ok, true)
})

test('5. 微小强度变化抑制必须对比【衰减后当前有效状态】而非磁盘历史存储值', () => {
  // 假设磁盘历史上在 6 小时前写入了 intensity: 0.8 的 task_completed
  // 经过 6 小时衰减后，当前有效状态实际已衰减到 0.10 (回归 calm: 0.0)
  const decayedEffective = {
    schemaVersion: 1,
    state: 'calm',
    intensity: 0.0,
    updatedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    reason: 'task_completed',
  }

  // 此时发生新事件，提交 intensity: 0.75 的 task_completed
  // 虽然与磁盘历史值 0.8 很接近（0.8 - 0.75 = 0.05），但与当前【有效状态】0.0 相比是重大新事件！
  const decision = shouldUpdateMood(decayedEffective, {
    state: 'cheerful',
    intensity: 0.75,
    reason: 'task_completed',
  })
  // 必须判定允许更新，绝不能被错误抑制！
  assert.equal(decision.ok, true)
})

// ---------------------------------------------------------------- 3. 持久化与存储容错
test('6. readMood 文件不存在时返回默认基准 calm，不抛异常', () => {
  const root = tmp()
  const m = readMood(root)
  assert.equal(m.state, 'calm')
  assert.equal(m.intensity, 0.0)
  assert.equal(m.reason, 'baseline')
  assert.equal(m.schemaVersion, 1)
})

test('7. updateMood 正常更新、落盘并能读回，resetMood 重置为基准', () => {
  const root = tmp()

  const t0 = new Date('2026-10-26T12:00:00.000Z')
  const res = updateMood(
    root,
    { state: 'cheerful', intensity: 0.7, reason: 'task_completed' },
    t0
  )
  assert.equal(res.ok, true)
  assert.equal(res.mood.state, 'cheerful')
  assert.equal(res.mood.intensity, 0.7)
  assert.equal(res.mood.reason, 'task_completed')

  // 磁盘文件已存在且为合法 JSON
  const persisted = readPersistedMood(root)
  assert.equal(persisted.state, 'cheerful')
  assert.equal(persisted.intensity, 0.7)

  // 立即读取有效状态
  const eff = readMood(root, t0)
  assert.equal(eff.state, 'cheerful')
  assert.equal(eff.intensity, 0.7)

  // 重置
  const rReset = resetMood(root, new Date('2026-10-26T12:05:00.000Z'))
  assert.equal(rReset.ok, true)
  assert.equal(rReset.mood.state, 'calm')
  assert.equal(rReset.mood.intensity, 0.0)

  // 读回确认已恢复 baseline
  const afterReset = readMood(root)
  assert.equal(afterReset.state, 'calm')
  assert.equal(afterReset.intensity, 0.0)
})

test('8. 损坏 JSON 与非法 Schema：只读安全回退，绝不覆盖破坏磁盘现场', () => {
  const root = tmp()
  const bodyDir = path.join(root, 'body')
  fs.mkdirSync(bodyDir, { recursive: true })
  const file = path.join(bodyDir, MOOD_FILE)

  // 构造损坏 JSON 内容
  const corruptContent = '{ "schemaVersion": 1, "state": "cheerful", "intensity": MALFORMED...'
  fs.writeFileSync(file, corruptContent, 'utf8')

  // 调用 readMood，必须安全回退至默认 calm，绝不抛出异常
  const m = readMood(root)
  assert.equal(m.state, 'calm')
  assert.equal(m.intensity, 0.0)

  // 核心断言：磁盘上的损坏现场必须原封不动完好保留，绝不能在读操作中被自动覆写
  const rawAfterRead = fs.readFileSync(file, 'utf8')
  assert.equal(rawAfterRead, corruptContent)
})

test('9. 锁超时保护：外部占用锁目录时，updateMood 与 resetMood 均返回明确失败，原数据不被损坏', () => {
  const root = tmp()
  // 先写入一条有效记录
  updateMood(root, { state: 'engaged', intensity: 0.6, reason: 'focus' })
  const original = readPersistedMood(root)
  assert.equal(original.state, 'engaged')

  // 外部占用锁目录
  const bodyDir = path.join(root, 'body')
  const lockDir = path.join(bodyDir, `${MOOD_FILE}.lock`)
  const lockToken = acquireDirLock(lockDir)
  assert.ok(lockToken)

  try {
    // 调用 updateMood，必须明确返回 lock-timeout 业务失败，绝不伪报成功
    const resUpdate = updateMood(root, { state: 'cheerful', intensity: 0.8, reason: 'task_completed' })
    assert.equal(resUpdate.ok, false)
    assert.equal(resUpdate.reason, 'lock-timeout')

    // 调用 resetMood，同样必须明确返回 lock-timeout 失败
    const resReset = resetMood(root)
    assert.equal(resReset.ok, false)
    assert.equal(resReset.reason, 'lock-timeout')
  } finally {
    releaseDirLock(lockDir, lockToken)
  }

  // 核心断言：原文件数据完好无损，未发生任何覆写或破损
  const after = readPersistedMood(root)
  assert.equal(after.state, 'engaged')
  assert.equal(after.intensity, 0.6)
})

// ---------------------------------------------------------------- 4. 并发互斥与多进程测试
test('10. resetMood 与 updateMood 跨进程并发互斥：串行化写入，无损坏 JSON', async () => {
  const root = tmp()
  updateMood(root, { state: 'calm', intensity: 0.0, reason: 'baseline' })

  const storeModuleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../lib/store.js')).href

  const runSubprocess = (mode) => {
    return new Promise((resolve, reject) => {
      const script = `
        import('${storeModuleUrl}').then((m) => {
          if (process.argv[2] === 'update') {
            m.updateMood(process.argv[1], { state: 'cheerful', intensity: 0.75, reason: 'task_completed' });
          } else {
            m.resetMood(process.argv[1]);
          }
          process.exit(0);
        }).catch((err) => {
          console.error(err);
          process.exit(1);
        });
      `
      const child = spawn(process.execPath, [
        '--input-type=module',
        '-e',
        script,
        root,
        mode,
      ])
      let stderr = ''
      child.stderr.on('data', (d) => { stderr += d })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Subprocess exited with code ${code}: ${stderr}`))
      })
    })
  }

  // 并发拉起两进程：一个执行 updateMood，另一个执行 resetMood
  await Promise.all([runSubprocess('update'), runSubprocess('reset')])

  // 核心断言：最终落盘的文件必须是合法的 JSON 格式，且 state 只能是 cheerful 或 calm 之一，绝无混叠破损
  const persisted = readPersistedMood(root)
  assert.ok(persisted !== null)
  assert.ok(['cheerful', 'calm'].includes(persisted.state))
  assert.equal(persisted.schemaVersion, 1)
})

// ---------------------------------------------------------------- 5. 提示词隔离与低侵入表现
test('11. formatMoodPrompt 提示词纯净隔离：无自由文本 reason，无模型思考过程', () => {
  // 1. calm 或低强度 (<= 0.15) 时，返回空字符串（零侵入、零 token 消耗）
  assert.equal(formatMoodPrompt({ state: 'calm', intensity: 0 }), '')
  assert.equal(formatMoodPrompt({ state: 'cheerful', intensity: 0.12 }), '')
  assert.equal(formatMoodPrompt(null), '')

  // 2. 活跃状态 (intensity > 0.15) 映射为预定义文案
  const promptCheerful = formatMoodPrompt({ state: 'cheerful', intensity: 0.6, reason: 'task_completed' })
  assert.ok(promptCheerful.includes('### 当前表达状态'))
  assert.ok(promptCheerful.includes('当前倾向：轻快、愉悦。'))
  assert.ok(promptCheerful.includes('表达建议：可以适度活泼、亲切，但保持自然。'))
  assert.ok(promptCheerful.includes('该状态是短期表达参考，不是固定人格规则。'))

  // 核心安全隔离断言：绝对不能将内部 reason 字符串或任何未经验证的自由文本塞入系统提示词
  assert.equal(promptCheerful.includes('task_completed'), false)
  assert.equal(promptCheerful.includes('0.6'), false)

  // 3. 验证 tired 包含舒缓建议且不作为拒单理由声明
  const promptTired = formatMoodPrompt({ state: 'tired', intensity: 0.45, reason: 'deep_work' })
  assert.ok(promptTired.includes('当前倾向：低活跃、舒缓。'))
  assert.ok(promptTired.includes('不作为拒绝任务的理由'))
  assert.equal(promptTired.includes('deep_work'), false)
})

test('12. buildMoodSection 集成与降级测试', () => {
  const root = tmp()

  // 1. 默认无文件时，返回空串（零侵入）
  assert.equal(buildMoodSection(root), '')

  // 2. 正常更新后，注入预定义段落与完整三维背景
  updateMood(root, { state: 'engaged', intensity: 0.65, reason: 'focus' })
  const section = buildMoodSection(root)
  assert.ok(section.includes('当前倾向：投入、专注。'))
  assert.ok(section.includes('清晰、积极推进，保持专注节奏。'))
  assert.ok(section.includes('连续底噪参考：'))
  assert.ok(section.includes('状态背景：近期进入深度专注攻坚。'))

  // 3. 损坏文件时，优雅降级返回空串，绝不抛出异常破坏上下文装配
  const file = path.join(root, 'body', MOOD_FILE)
  fs.writeFileSync(file, 'BROKEN_DATA', 'utf8')
  assert.equal(buildMoodSection(root), '')
})

test('13. heart_mood 工具执行层处理成功、业务拒绝、锁超时与异常反馈', async () => {
  const root = tmp()

  const executeMoodTool = async (args) => {
    try {
      const rawIntensity = args && args.intensity
      const numIntensity = typeof rawIntensity === 'number' ? rawIntensity : Number(rawIntensity)
      const res = updateMood(root, {
        state: args && args.state,
        intensity: numIntensity,
        reason: args && args.reason,
      })
      if (!res.ok) {
        return { message: `未更新状态：${res.message || res.reason}` }
      }
      const m = res.mood
      return { message: `已更新当前表达状态：${m.state}（强度 ${m.intensity}，原因：${m.reason}）` }
    } catch (err) {
      return { message: `更新状态失败：${err.message || String(err)}` }
    }
  }

  // 1. 成功更新
  const msgOk = await executeMoodTool({ state: 'cheerful', intensity: 0.7, reason: 'task_completed' })
  assert.ok(msgOk.message.includes('已更新当前表达状态：cheerful（强度 0.7，原因：task_completed）'))

  // 2. 状态与原因不匹配业务拒绝
  const msgMismatch = await executeMoodTool({ state: 'excited', intensity: 0.4, reason: 'task_completed' })
  assert.ok(msgMismatch.message.includes('未更新状态：状态 "excited" 在原因 "task_completed" 下要求强度至少为 0.7'))

  // 3. 无显著新事件拦截
  const msgNoChange = await executeMoodTool({ state: 'cheerful', intensity: 0.72, reason: 'task_completed' })
  assert.ok(msgNoChange.message.includes('未更新状态：与当前有效状态相比无显著新事件变化'))

  // 4. 锁超时
  const lockDir = path.join(root, 'body', `${MOOD_FILE}.lock`)
  const token = acquireDirLock(lockDir)
  assert.ok(token)
  try {
    const msgLock = await executeMoodTool({ state: 'engaged', intensity: 0.8, reason: 'focus' })
    assert.ok(msgLock.message.includes('未更新状态：获取文件锁超时'))
  } finally {
    releaseDirLock(lockDir, token)
  }

  // 5. 存储异常（写入只读或无效路径）
  const fakeRoot = path.join(tmp(), 'not-a-dir-file')
  fs.writeFileSync(fakeRoot, 'dummy')
  const executeWithFakeRoot = async () => {
    try {
      updateMood(fakeRoot, { state: 'calm', intensity: 0, reason: 'baseline' })
      return { message: 'ok' }
    } catch (err) {
      return { message: `更新状态失败：${err.message}` }
    }
  }
  const msgErr = await executeWithFakeRoot()
  assert.ok(msgErr.message.includes('更新状态失败：'))
})

test('14. 低自主性架构断言：零后台定时器、零主动活动、零长期记忆写入', () => {
  const moodCode = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/mood.js'), 'utf8')
  // 静态断言：不得包含 setInterval、setTimeout 或轮询写盘逻辑
  assert.equal(moodCode.includes('setInterval'), false)
  assert.equal(moodCode.includes('setTimeout'), false)

  // 静态断言：不得向 notebook.md、facts.md 或 MEMORY 写入长期记忆
  assert.equal(moodCode.includes('appendNotebook'), false)
  assert.equal(moodCode.includes('appendFact'), false)
  assert.equal(moodCode.includes('appendMemory'), false)

  // 静态断言：不得触发主动开口或通知
  assert.equal(moodCode.includes('enqueueSay'), false)
  assert.equal(moodCode.includes('followup'), false)
})

// ---------------------------------------------------------------- 6. 持久化记录严格校验与损坏现场保留
test('15. isValidPersistedMood 纯函数边界验证（状态、强度、时间戳严格校验）', () => {
  const validRecord = {
    schemaVersion: 1,
    state: 'cheerful',
    intensity: 0.8,
    reason: 'task_completed',
    updatedAt: '2026-10-26T12:00:00.000Z',
  }

  // 合法记录
  assert.equal(isValidPersistedMood(validRecord), true)
  assert.equal(isValidPersistedMood({ ...validRecord, state: 'calm', intensity: 0.0, reason: 'baseline' }), true)
  assert.equal(isValidPersistedMood({ ...validRecord, state: 'tired', intensity: 0.5, reason: 'deep_work' }), true)

  // 非对象或数组
  assert.equal(isValidPersistedMood(null), false)
  assert.equal(isValidPersistedMood(undefined), false)
  assert.equal(isValidPersistedMood('string'), false)
  assert.equal(isValidPersistedMood(123), false)
  assert.equal(isValidPersistedMood([validRecord]), false)

  // schemaVersion 校验
  assert.equal(isValidPersistedMood({ ...validRecord, schemaVersion: 2 }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, schemaVersion: 0 }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, schemaVersion: '1' }), false)

  // state 枚举校验
  assert.equal(isValidPersistedMood({ ...validRecord, state: 'angry' }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, state: '' }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, state: null }), false)

  // intensity 区间 [0.0, 1.0] 与有限数值校验
  assert.equal(isValidPersistedMood({ ...validRecord, intensity: -0.1 }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, intensity: 1.01 }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, intensity: 10.0 }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, intensity: NaN }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, intensity: Infinity }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, intensity: '0.8' }), false)

  // reason 枚举校验
  assert.equal(isValidPersistedMood({ ...validRecord, reason: 'unknown_reason' }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, reason: '' }), false)

  // updatedAt 校验（非空字符串且合法可解析时间戳）
  assert.equal(isValidPersistedMood({ ...validRecord, updatedAt: '' }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, updatedAt: '   ' }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, updatedAt: 'invalid-date' }), false)
  assert.equal(isValidPersistedMood({ ...validRecord, updatedAt: 1729944000000 }), false)
  const withoutUpdatedAt = { ...validRecord }
  delete withoutUpdatedAt.updatedAt
  assert.equal(isValidPersistedMood(withoutUpdatedAt), false)
})

test('16. 持久化记录超界强度或非法时间戳：readMood 与 getEffectiveMood 安全回退为 calm 且磁盘现场未被修改', () => {
  // Case 1: intensity 超过 1.0 (例如 10.0)
  const root1 = tmp()
  const file1 = path.join(root1, 'body', MOOD_FILE)
  fs.mkdirSync(path.dirname(file1), { recursive: true })
  const raw1 = JSON.stringify({
    schemaVersion: 1,
    state: 'cheerful',
    intensity: 10.0,
    reason: 'task_completed',
    updatedAt: new Date().toISOString(),
  }, null, 2)
  fs.writeFileSync(file1, raw1, 'utf8')

  const eff1 = readMood(root1)
  assert.equal(eff1.state, 'calm')
  assert.equal(eff1.intensity, 0.0)
  assert.equal(eff1.reason, 'baseline')
  assert.equal(fs.readFileSync(file1, 'utf8'), raw1, '磁盘原文件绝不能被覆盖修改')

  // Case 2: intensity 小于 0.0 (例如 -0.5)
  const root2 = tmp()
  const file2 = path.join(root2, 'body', MOOD_FILE)
  fs.mkdirSync(path.dirname(file2), { recursive: true })
  const raw2 = JSON.stringify({
    schemaVersion: 1,
    state: 'engaged',
    intensity: -0.5,
    reason: 'focus',
    updatedAt: new Date().toISOString(),
  }, null, 2)
  fs.writeFileSync(file2, raw2, 'utf8')

  const eff2 = readMood(root2)
  assert.equal(eff2.state, 'calm')
  assert.equal(eff2.intensity, 0.0)
  assert.equal(fs.readFileSync(file2, 'utf8'), raw2, '磁盘原文件绝不能被覆盖修改')

  // Case 3: 缺失 updatedAt
  const root3 = tmp()
  const file3 = path.join(root3, 'body', MOOD_FILE)
  fs.mkdirSync(path.dirname(file3), { recursive: true })
  const raw3 = JSON.stringify({
    schemaVersion: 1,
    state: 'cheerful',
    intensity: 0.8,
    reason: 'task_completed',
  }, null, 2)
  fs.writeFileSync(file3, raw3, 'utf8')

  const eff3 = readMood(root3)
  assert.equal(eff3.state, 'calm')
  assert.equal(eff3.intensity, 0.0)
  assert.equal(fs.readFileSync(file3, 'utf8'), raw3, '磁盘原文件绝不能被覆盖修改')

  // Case 4: 非法时间戳字符串 (如 'not-a-valid-date')
  const root4 = tmp()
  const file4 = path.join(root4, 'body', MOOD_FILE)
  fs.mkdirSync(path.dirname(file4), { recursive: true })
  const raw4 = JSON.stringify({
    schemaVersion: 1,
    state: 'excited',
    intensity: 0.85,
    reason: 'task_completed',
    updatedAt: 'not-a-valid-date',
  }, null, 2)
  fs.writeFileSync(file4, raw4, 'utf8')

  const eff4 = readMood(root4)
  assert.equal(eff4.state, 'calm')
  assert.equal(eff4.intensity, 0.0)
  assert.equal(fs.readFileSync(file4, 'utf8'), raw4, '磁盘原文件绝不能被覆盖修改')

  // 直接调用 getEffectiveMood 纯函数验证
  assert.equal(getEffectiveMood({ schemaVersion: 1, state: 'cheerful', intensity: 10.0, reason: 'task_completed', updatedAt: '2026-10-26T12:00:00.000Z' }).state, 'calm')
  assert.equal(getEffectiveMood({ schemaVersion: 1, state: 'cheerful', intensity: 0.8, reason: 'task_completed', updatedAt: 'not-a-date' }).state, 'calm')
  assert.equal(getEffectiveMood({ schemaVersion: 1, state: 'cheerful', intensity: 0.8, reason: 'task_completed' }).state, 'calm')
})

// ---------------------------------------------------------------- 7. Mood 2.0 连续内生状态与冲量合成验证
test('17. Mood 2.0 三维连续向非零基线平滑衰减精度与时钟倒退防御（12h / 4h / 24h 半衰期）', () => {
  // 基线：valence = 0.2, arousal = 0.3, energy = 0.6
  assert.equal(BASELINE.valence, 0.2)
  assert.equal(BASELINE.arousal, 0.3)
  assert.equal(BASELINE.energy, 0.6)

  // 1. valence 衰减：半衰期 12h，从 0.8 衰减 12h 后应为 0.2 + (0.8 - 0.2) * 0.5 = 0.5
  const v12h = decayDimension(0.8, BASELINE.valence, 12 * 3600 * 1000, HALF_LIFE_MS.valence)
  assert.ok(Math.abs(v12h - 0.5) < 1e-6)

  // 2. arousal 衰减：半衰期 4h，从 0.7 衰减 4h 后应为 0.3 + (0.7 - 0.3) * 0.5 = 0.5
  const a4h = decayDimension(0.7, BASELINE.arousal, 4 * 3600 * 1000, HALF_LIFE_MS.arousal)
  assert.ok(Math.abs(a4h - 0.5) < 1e-6)

  // 3. energy 衰减：半衰期 24h，从 0.2（疲惫）衰减 24h 后应向基线 0.6 回升至 0.6 + (0.2 - 0.6) * 0.5 = 0.4
  const e24h = decayDimension(0.2, BASELINE.energy, 24 * 3600 * 1000, HALF_LIFE_MS.energy)
  assert.ok(Math.abs(e24h - 0.4) < 1e-6)

  // 4. 经过充分长时间（72h 后），三维状态几乎完全回归非零基线
  const v72h = decayDimension(0.8, BASELINE.valence, 72 * 3600 * 1000, HALF_LIFE_MS.valence)
  const a72h = decayDimension(0.7, BASELINE.arousal, 72 * 3600 * 1000, HALF_LIFE_MS.arousal)
  const e72h = decayDimension(0.2, BASELINE.energy, 72 * 3600 * 1000, HALF_LIFE_MS.energy)
  assert.ok(Math.abs(v72h - BASELINE.valence) < 0.02)
  assert.ok(Math.abs(a72h - BASELINE.arousal) < 0.01)
  assert.ok(Math.abs(e72h - BASELINE.energy) < 0.06)

  // 5. 时钟倒退防御：elapsedMs < 0 时强制按当前值返回，绝不倒流放大
  const vNegative = decayDimension(0.8, BASELINE.valence, -3600 * 1000, HALF_LIFE_MS.valence)
  assert.equal(vNegative, 0.8)
})

test('18. Mood 2.0 冲量合成：新事件在衰减后的有效状态上叠加，不丢失前序未衰减历史', () => {
  const root = tmp()
  const t0 = new Date('2026-10-26T10:00:00.000Z')

  // 事件 1: focus 产生 engaged 状态（提升 arousal）
  const res1 = updateMood(root, { state: 'engaged', intensity: 0.6, reason: 'focus' }, t0)
  assert.equal(res1.ok, true)
  assert.ok(res1.mood.arousal > BASELINE.arousal)
  const a1 = res1.mood.arousal

  // 经过 2 小时（arousal 半衰期为 4 小时，此时尚未完全回归基线）
  const t1 = new Date(t0.getTime() + 2 * 3600 * 1000)
  const eff1 = readMood(root, t1)
  assert.ok(eff1.arousal > BASELINE.arousal)
  assert.ok(eff1.arousal < a1)

  // 事件 2: 此时完成了任务，触发 cheerful（主要提升 valence）
  const res2 = updateMood(root, { state: 'cheerful', intensity: 0.7, reason: 'task_completed' }, t1)
  assert.equal(res2.ok, true)

  // 核心断言：事件 2 的状态是叠加在 eff1 之上的，arousal 依然保留了事件 1 未衰减完的唤醒余热！
  assert.ok(res2.mood.valence > BASELINE.valence)
  assert.ok(res2.mood.arousal > BASELINE.arousal)
})

test('19. Mood 2.0 欧氏距离与 why 显隐：偏离基线显著时保留 why，收敛至底噪时淡化为日常基准', () => {
  const t0 = new Date('2026-10-26T12:00:00.000Z')
  const root = tmp()

  // 1. 产生显著事件
  updateMood(root, { state: 'excited', intensity: 0.8, reason: 'task_completed' }, t0)
  const effActive = readMood(root, t0)
  const distActive = calculateDistanceToBaseline(effActive.valence, effActive.arousal, effActive.energy)
  assert.ok(distActive > LOW_INTENSITY_THRESHOLD)
  assert.equal(effActive.why, '完成了一项有意义的任务')

  // 2. 经过 48 小时，状态已深度衰减收敛至基线附近
  const tLate = new Date(t0.getTime() + 48 * 3600 * 1000)
  const effLate = readMood(root, tLate)
  const distLate = calculateDistanceToBaseline(effLate.valence, effLate.arousal, effLate.energy)
  assert.ok(distLate <= LOW_INTENSITY_THRESHOLD)
  // 核心断言：why 已弱化为日常基准状态，不反复强化陈旧历史事件
  assert.equal(effLate.why, '日常基准状态')
})

test('20. Mood 2.0 旧版数据透明升级：纯 v1 记录读取时平滑转换为 3D 状态', () => {
  const root = tmp()
  const bodyDir = path.join(root, 'body')
  fs.mkdirSync(bodyDir, { recursive: true })
  const file = path.join(bodyDir, MOOD_FILE)

  // 模拟只有旧版 v1 字段的记录文件
  const legacyRecord = {
    schemaVersion: 1,
    state: 'cheerful',
    intensity: 0.7,
    reason: 'positive_interaction',
    updatedAt: new Date().toISOString(),
  }
  fs.writeFileSync(file, JSON.stringify(legacyRecord, null, 2), 'utf8')

  // 调用 readMood 读取
  const eff = readMood(root)
  // 既有兼容字段
  assert.equal(eff.state, 'cheerful')
  assert.equal(eff.intensity, 0.7)
  // 自动生成的 3D 属性
  assert.ok(typeof eff.valence === 'number')
  assert.ok(eff.valence > BASELINE.valence)
  assert.ok(typeof eff.arousal === 'number')
  assert.ok(typeof eff.energy === 'number')
  assert.equal(eff.why, '与用户有了积极愉快的互动')
})

test('21. Mood 2.0 format3DMoodPrompt 弱约束提示词：底噪静默、自然语言映射、无数值泄露、精力不作为拒单理由', () => {
  // 1. 基线底噪时返回空串，不消耗日常 token
  const baselineMood = {
    valence: BASELINE.valence,
    arousal: BASELINE.arousal,
    energy: BASELINE.energy,
    why: '日常基准状态',
  }
  assert.equal(format3DMoodPrompt(baselineMood), '')

  // 2. 偏离基线时输出弱约束指引
  const activeMood = {
    valence: 0.65,
    arousal: 0.6,
    energy: 0.8,
    why: '攻克了复杂技术难题',
  }
  const prompt = format3DMoodPrompt(activeMood)
  assert.ok(prompt.includes('### 当前内部状态（短期表达倾向参考）'))
  assert.ok(prompt.includes('略偏愉悦舒畅'))
  assert.ok(prompt.includes('较为活跃敏锐'))
  assert.ok(prompt.includes('精力充沛'))
  assert.ok(prompt.includes('近期攻克了复杂技术难题'))
  assert.ok(prompt.includes('精力状态绝不作为拒绝任务的理由'))

  // 严禁泄露原始数值
  assert.equal(prompt.includes('0.65'), false)
  assert.equal(prompt.includes('0.6'), false)
  assert.equal(prompt.includes('0.8'), false)
})

test('22. Mood 2.0 resetMood 重置后立即平复回中性基线', () => {
  const root = tmp()
  updateMood(root, { state: 'excited', intensity: 0.85, reason: 'task_completed' })

  // 重置
  const rReset = resetMood(root)
  assert.equal(rReset.ok, true)
  assert.equal(rReset.mood.valence, BASELINE.valence)
  assert.equal(rReset.mood.arousal, BASELINE.arousal)
  assert.equal(rReset.mood.energy, BASELINE.energy)
  assert.equal(rReset.mood.state, 'calm')
  assert.equal(rReset.mood.intensity, 0.0)
})

