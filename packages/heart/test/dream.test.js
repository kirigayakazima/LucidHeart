import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  filterSessionMessages,
  validateCandidateInsight,
  parseModelInsights,
  generateInsightId,
  normalizeStatement,
  readInsights,
  saveInsights,
  updateInsightStatus,
  applyInsightTransition,
  promoteInsight,
  resolvePromotionTarget,
  DREAM_DIR,
  INSIGHTS_FILE,
  INSIGHTS_LOCK,
} from '../lib/dream.js'
import {
  acquireDirLock,
  releaseDirLock,
  appendFact,
  appendNotebook,
  appendVoiceLearned,
  readFacts,
  readNotebook,
  readVoiceLearned,
  readModuleLogs,
} from '../lib/store.js'

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heart-dream-test-'))
}

// ---------------------------------------------------------------- 一、切片清洗与格式化测试
test('1. filterSessionMessages：有效消息抽取、系统消息过滤、长消息截断与字符预算', () => {
  const messages = [
    { role: 'system', content: 'You are an AI assistant.' },
    { role: 'user', content: '系统信息注入', source: { kind: 'system-inject' } },
    { role: 'user', content: '请帮我优化代码风格' },
    { role: 'assistant', content: '建议先给出最小可执行方案，再解释背景。' },
    { role: 'user', content: '很好，请继续。' },
    { role: 'assistant', content: 'A'.repeat(1200) }, // 超过 800 字截断
  ]

  const slice = filterSessionMessages(messages, { maxTurns: 10, maxChars: 2000 })
  assert.equal(slice.turns, 2) // 2 条有效 user 消息
  assert.equal(slice.messages.length, 4)
  assert.equal(slice.messages[0].role, 'user')
  assert.equal(slice.messages[0].content, '请帮我优化代码风格')
  assert.ok(slice.messages[3].content.includes('[截断]'))
  assert.ok(slice.messages[3].content.length <= 820)
  assert.ok(slice.formattedText.includes('[用户]: 请帮我优化代码风格'))
  assert.ok(slice.formattedText.includes('[助手]: 建议先给出最小可执行方案'))

  // 超限字符截断验证（从最早轮次逆序截断）
  const tightSlice = filterSessionMessages(messages, { maxTurns: 10, maxChars: 100 })
  assert.ok(tightSlice.totalChars <= 100 || tightSlice.messages.length === 1)
})

// ---------------------------------------------------------------- 二、候选校验与模型输出解析
test('2. validateCandidateInsight：字段合法性与边界严格校验', () => {
  // 合法条目
  const ok = validateCandidateInsight({
    category: 'workflow',
    type: 'observation',
    statement: '用户偏好先给方案再解释背景',
    confidence: 0.9,
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.normalized.category, 'workflow')
  assert.equal(ok.normalized.type, 'observation')
  assert.equal(ok.normalized.confidence, 0.9)

  // 非法分类
  assert.equal(
    validateCandidateInsight({ category: 'invalid', type: 'fact', statement: 'xxx' }).ok,
    false
  )

  // 非法认识论类型
  assert.equal(
    validateCandidateInsight({ category: 'workflow', type: 'unknown_type', statement: 'xxx' }).ok,
    false
  )

  // 空正文
  assert.equal(
    validateCandidateInsight({ category: 'workflow', type: 'fact', statement: '   ' }).ok,
    false
  )

  // 超过 200 字
  assert.equal(
    validateCandidateInsight({ category: 'workflow', type: 'fact', statement: 'x'.repeat(201) }).ok,
    false
  )

  // 非法置信度
  assert.equal(
    validateCandidateInsight({ category: 'workflow', type: 'fact', statement: 'xxx', confidence: 1.5 }).ok,
    false
  )
})

test('3. parseModelInsights：模型输出容错解析与过度猜测防御', () => {
  // 1. 标准 Markdown 代码块包裹的 JSON
  const markdownJson = '```json\n[{"category":"workflow","type":"observation","statement":"测试经验"}]\n```'
  const parsed1 = parseModelInsights(markdownJson)
  assert.equal(parsed1.ok, true)
  assert.equal(parsed1.insights.length, 1)
  assert.equal(parsed1.insights[0].statement, '测试经验')

  // 2. 超出 3 条硬截断为前 3 条
  const fourItems = JSON.stringify([
    { category: 'workflow', type: 'fact', statement: '条目1' },
    { category: 'workflow', type: 'fact', statement: '条目2' },
    { category: 'workflow', type: 'fact', statement: '条目3' },
    { category: 'workflow', type: 'fact', statement: '条目4' },
  ])
  const parsed2 = parseModelInsights(fourItems)
  assert.equal(parsed2.ok, true)
  assert.equal(parsed2.insights.length, 3)

  // 3. 语法截断或坏 JSON 绝不猜测修复
  const brokenJson = '[{"category":"workflow","statement":'
  const parsed3 = parseModelInsights(brokenJson)
  assert.equal(parsed3.ok, false)
  assert.equal(parsed3.reason, 'invalid-json')

  // 4. 非数组对象拒绝
  const notArray = '{"category":"workflow","statement":"单个对象"}'
  const parsed4 = parseModelInsights(notArray)
  assert.equal(parsed4.ok, false)
  assert.equal(parsed4.reason, 'not-an-array')
})

// ---------------------------------------------------------------- 三、确定性 ID 与内容去重
test('4. generateInsightId：完整 64 位 SHA-256 确定性哈希与空白规范化', () => {
  const id1 = generateInsightId('workflow', '用户偏好 先给方案 再解释背景')
  const id2 = generateInsightId('WORKFLOW  ', '  用户偏好 先给方案 再解释背景   ')
  const id3 = generateInsightId('workflow', '用户偏好   先给方案    再解释背景') // 多空格压缩为单空格

  assert.equal(typeof id1, 'string')
  assert.equal(id1.length, 64) // 完整 SHA-256 长度
  assert.equal(/^[0-9a-f]{64}$/.test(id1), true)
  assert.equal(id1, id2)
  assert.equal(id1, id3)

  const diffId = generateInsightId('communication', '用户偏好先给方案再解释背景')
  assert.notEqual(id1, diffId)
})

// ---------------------------------------------------------------- 四、存储落盘、去重与锁内重读
test('5. saveInsights：首次正常写入、幂等去重与读取回显', () => {
  const root = tmp()
  const candidate = {
    category: 'workflow',
    type: 'observation',
    statement: '测试保存经验条目',
    confidence: 0.85,
  }

  // 1. 首次保存
  const res1 = saveInsights(root, [candidate], { session: 'sess-001', turnCount: 3 })
  assert.equal(res1.ok, true)
  assert.equal(res1.saved.length, 1)
  assert.equal(res1.skipped.length, 0)
  assert.equal(res1.saved[0].status, 'candidate')

  // 验证磁盘文件存在且合法
  const read1 = readInsights(root)
  assert.equal(read1.ok, true)
  assert.equal(read1.items.length, 1)
  assert.equal(read1.items[0].statement, '测试保存经验条目')
  assert.equal(read1.items[0].source.session, 'sess-001')

  // 2. 相同内容重复保存：确定性 ID 去重拦截，不重复写入
  const res2 = saveInsights(root, [candidate], { session: 'sess-002', turnCount: 5 })
  assert.equal(res2.ok, true)
  assert.equal(res2.saved.length, 0)
  assert.equal(res2.skipped.length, 1)
  assert.equal(res2.skipped[0].reason, 'duplicate')

  // 磁盘依然只有 1 条记录
  const read2 = readInsights(root)
  assert.equal(read2.items.length, 1)
})

test('6. 锁超时防御：外部占用锁目录时，写入返回明确失败，原数据完整未被改写', () => {
  const root = tmp()
  const dreamDir = path.join(root, DREAM_DIR)
  fs.mkdirSync(dreamDir, { recursive: true })
  const lockDir = path.join(dreamDir, INSIGHTS_LOCK)

  // 外部获取锁
  const lockToken = acquireDirLock(lockDir)
  assert.ok(lockToken)

  try {
    const candidate = {
      category: 'workflow',
      type: 'fact',
      statement: '锁超时测试经验',
    }
    const res = saveInsights(root, [candidate])
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'lock-timeout')

    // 断言原文件未被创建或写入
    const file = path.join(dreamDir, INSIGHTS_FILE)
    assert.equal(fs.existsSync(file), false)
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
})

test('7. 损坏文件写保护：检测到坏文件时拒绝整文件原子覆盖，磁盘现场 100% 留存', () => {
  const root = tmp()
  const dreamDir = path.join(root, DREAM_DIR)
  fs.mkdirSync(dreamDir, { recursive: true })
  const file = path.join(dreamDir, INSIGHTS_FILE)

  // 手工写入损坏的截断 JSON
  const corruptedContent = '[{"id": "ins-1", "bad_json": \n'
  fs.writeFileSync(file, corruptedContent, 'utf8')

  // 1. 读取识别为 corrupted
  const readRes = readInsights(root)
  assert.equal(readRes.ok, false)
  assert.equal(readRes.corrupted, true)

  // 2. 尝试执行写入保存操作：触发写保护拒绝覆盖
  const resSave = saveInsights(root, [
    { category: 'general', type: 'fact', statement: '新经验' },
  ])
  assert.equal(resSave.ok, false)
  assert.equal(resSave.reason, 'corrupted-data')

  // 3. 断言磁盘损坏现场 100% 保持原样，绝不被整文件覆盖抹除
  const diskContent = fs.readFileSync(file, 'utf8')
  assert.equal(diskContent, corruptedContent)

  // 4. 尝试执行审核操作：同样触发写保护拒绝覆盖
  const resUpdate = updateInsightStatus(root, 'some-id', 'confirm')
  assert.equal(resUpdate.ok, false)
  assert.equal(resUpdate.reason, 'corrupted-data')
})

// ---------------------------------------------------------------- 五、审核状态流转测试
test('8. applyInsightTransition & updateInsightStatus：审核状态流转与非法转换拦截', () => {
  const root = tmp()
  const candidate = {
    category: 'communication',
    type: 'observation',
    statement: '用户喜欢简明扼要的回复',
  }
  const saveRes = saveInsights(root, [candidate])
  assert.equal(saveRes.ok, true)
  const id = saveRes.saved[0].id

  // 1. 确认流转: candidate -> confirmed
  const confirmRes = updateInsightStatus(root, id, 'confirm')
  assert.equal(confirmRes.ok, true)
  assert.equal(confirmRes.changed, true)
  assert.equal(confirmRes.insight.status, 'confirmed')

  // 2. 幂等确认: confirmed -> confirmed
  const idemConfirm = updateInsightStatus(root, id, 'confirm')
  assert.equal(idemConfirm.ok, true)
  assert.equal(idemConfirm.changed, false)

  // 3. 非法转换拦截: 已 confirmed 条目不能直接 reject
  const illegalReject = updateInsightStatus(root, id, 'reject')
  assert.equal(illegalReject.ok, false)
  assert.equal(illegalReject.reason, 'illegal-transition')

  // 4. 对不存在的 ID 返回 not-found
  const notFound = updateInsightStatus(root, '0000000000000000000000000000000000000000000000000000000000000000', 'confirm')
  assert.equal(notFound.ok, false)
  assert.equal(notFound.reason, 'not-found')
})

test('9. 驳回流转: candidate -> rejected 并记录驳回原因', () => {
  const root = tmp()
  const candidate = {
    category: 'environment',
    type: 'hypothesis',
    statement: '推测对方处于嘈杂环境',
  }
  const saveRes = saveInsights(root, [candidate])
  const id = saveRes.saved[0].id

  // 驳回
  const rejectRes = updateInsightStatus(root, id, 'reject', { reason: '无可靠依据的过度猜测' })
  assert.equal(rejectRes.ok, true)
  assert.equal(rejectRes.insight.status, 'rejected')
  assert.equal(rejectRes.insight.statusReason, '无可靠依据的过度猜测')

  // 幂等驳回
  const idemReject = updateInsightStatus(root, id, 'reject')
  assert.equal(idemReject.ok, true)
  assert.equal(idemReject.changed, false)

  // 非法转换拦截: 已 rejected 条目不能直接 confirm
  const illegalConfirm = updateInsightStatus(root, id, 'confirm')
  assert.equal(illegalConfirm.ok, false)
  assert.equal(illegalConfirm.reason, 'illegal-transition')
})

// ---------------------------------------------------------------- 六、系统核心记忆文件写保护断言
test('10. 核心记忆写保护断言：reflect、confirm、reject 全流程绝不改动 facts、notebook、voice-learned', () => {
  const root = tmp()

  // 初始化写入一些基础记忆
  appendNotebook(root, '这是已有的自我准则')
  appendFact(root, '这是已有的稳定事实')
  appendVoiceLearned(root, '这是已有的表达偏好')

  const notebookFile = path.join(root, 'notebook.md')
  const factsFile = path.join(root, 'facts.md')
  const voiceFile = path.join(root, 'body', 'voice-learned.md')

  const hashBefore = {
    notebook: crypto.createHash('sha256').update(fs.readFileSync(notebookFile)).digest('hex'),
    facts: crypto.createHash('sha256').update(fs.readFileSync(factsFile)).digest('hex'),
    voice: crypto.createHash('sha256').update(fs.readFileSync(voiceFile)).digest('hex'),
  }

  // 执行 Dream 提炼保存
  const candidate = {
    category: 'workflow',
    type: 'observation',
    statement: '测试不会污染任何核心记忆文件',
  }
  const saveRes = saveInsights(root, [candidate])
  assert.equal(saveRes.ok, true)
  const id = saveRes.saved[0].id

  // 执行 Dream 审核确认
  const confirmRes = updateInsightStatus(root, id, 'confirm')
  assert.equal(confirmRes.ok, true)

  // 校验核心记忆文件哈希完全一致（逐字节零改动）
  const hashAfter = {
    notebook: crypto.createHash('sha256').update(fs.readFileSync(notebookFile)).digest('hex'),
    facts: crypto.createHash('sha256').update(fs.readFileSync(factsFile)).digest('hex'),
    voice: crypto.createHash('sha256').update(fs.readFileSync(voiceFile)).digest('hex'),
  }

  assert.equal(hashAfter.notebook, hashBefore.notebook)
  assert.equal(hashAfter.facts, hashBefore.facts)
  assert.equal(hashAfter.voice, hashBefore.voice)
})

// ---------------------------------------------------------------- 七、零后台定时器静态扫描
test('11. 零后台定时器静态扫描断言：lib/dream.js 严禁包含 setInterval、setTimeout、主动唤醒', () => {
  const dreamCode = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/dream.js'), 'utf8')
  assert.equal(dreamCode.includes('setInterval'), false, 'lib/dream.js 严禁包含 setInterval')
  assert.equal(dreamCode.includes('setTimeout'), false, 'lib/dream.js 严禁包含 setTimeout')
  assert.equal(dreamCode.includes('enqueueSay'), false, 'lib/dream.js 严禁调用 enqueueSay')
  assert.equal(dreamCode.includes('followup'), false, 'lib/dream.js 严禁调用 followup')
})

// ---------------------------------------------------------------- 八、工具执行层集成测试
test('12. heart_dream 工具执行层集成：reflect、list、show、confirm、reject 完整交互', async () => {
  const root = tmp()

  // 模拟 execute 工具执行逻辑
  const executeDreamTool = async (args, exec) => {
    const action = String((args && args.action) || 'reflect').trim().toLowerCase()
    if (action === 'reflect') {
      const caller = exec && exec.agent
      const session = caller && caller.id ? String(caller.id) : ''
      const rawMessages = caller && caller.session && caller.session.messages
      const sliceInfo = filterSessionMessages(rawMessages)

      if (args && args.insights) {
        const parsed = parseModelInsights(args.insights)
        if (!parsed.ok) return { message: `提炼失败：${parsed.message}` }
        const res = saveInsights(root, parsed.insights, { session, turnCount: sliceInfo.turns })
        if (!res.ok) return { message: `保存候选经验失败：${res.message || res.reason}` }
        const lines = [res.message]
        if (res.saved && res.saved.length > 0) {
          lines.push('')
          for (const it of res.saved) {
            lines.push(`- [${it.id.slice(0, 8)}] (${it.category}/${it.type}) ${it.statement}`)
          }
        }
        return { message: lines.join('\n') }
      }

      if (sliceInfo.turns === 0) return { message: '当前会话没有足够的对话轮次可供反思提炼。' }
      return { message: `已提取当前会话最近 ${sliceInfo.turns} 轮对话切片（共 ${sliceInfo.totalChars} 字）。` }
    }

    if (action === 'list') {
      const filterStatus = String((args && args.status) || 'candidate').trim().toLowerCase()
      const res = readInsights(root)
      if (res.corrupted) return { message: '读取失败：insights.json 数据文件损坏，已触发只读保护。' }
      let items = res.items
      if (filterStatus !== 'all') items = items.filter((it) => it.status === filterStatus)
      if (items.length === 0) return { message: `当前没有状态为 "${filterStatus}" 的经验条目。` }
      const lines = [`共找到 ${items.length} 条经验（状态: ${filterStatus}）：`]
      for (const it of items) {
        lines.push(`- [${it.id.slice(0, 8)}] [${it.status}] (${it.category}/${it.type}) ${it.statement}`)
      }
      return { message: lines.join('\n') }
    }

    if (action === 'show') {
      const id = String((args && args.id) || '').trim()
      if (!id) return { message: '请提供要查看的经验条目 ID' }
      const res = readInsights(root)
      const item = res.items.find((it) => it.id === id || (id.length >= 8 && it.id.startsWith(id)))
      if (!item) return { message: `未找到 ID 为 "${id}" 的经验条目。` }
      return { message: `经验详情 [${item.id}]：- 正文: ${item.statement}` }
    }

    if (action === 'confirm') {
      const id = String((args && args.id) || '').trim()
      const res = updateInsightStatus(root, id, 'confirm')
      if (!res.ok) return { message: `确认失败：${res.message || res.reason}` }
      return { message: `已成功确认经验 [${res.insight.id.slice(0, 8)}]：${res.insight.statement}` }
    }

    if (action === 'reject') {
      const id = String((args && args.id) || '').trim()
      const reason = args && args.reason ? String(args.reason).trim() : ''
      const res = updateInsightStatus(root, id, 'reject', { reason })
      if (!res.ok) return { message: `驳回失败：${res.message || res.reason}` }
      return { message: `已驳回经验 [${res.insight.id.slice(0, 8)}]${reason ? `（原因: ${reason}）` : ''}` }
    }

    return { message: `未知操作 "${action}"` }
  }

  // 1. 模拟空会话调用 reflect
  const emptyExec = { agent: { id: 'sess-1', session: { messages: [] } } }
  const emptyRes = await executeDreamTool({ action: 'reflect' }, emptyExec)
  assert.ok(emptyRes.message.includes('没有足够的对话轮次'))

  // 2. 模拟有对话的会话调用 reflect（引导提取）
  const validExec = {
    agent: {
      id: 'sess-2',
      session: {
        messages: [
          { role: 'user', content: '我希望所有测试都在本地跑通再提交' },
          { role: 'assistant', content: '明白，遵循严格本地全量测试规范。' },
        ],
      },
    },
  }
  const guideRes = await executeDreamTool({ action: 'reflect' }, validExec)
  assert.ok(guideRes.message.includes('已提取当前会话最近 1 轮对话切片'))

  // 3. 模拟模型提交提炼出的候选经验
  const modelInsights = JSON.stringify([
    {
      category: 'workflow',
      type: 'observation',
      statement: '要求所有测试在本地跑通后才能提交',
    },
  ])
  const saveRes = await executeDreamTool({ action: 'reflect', insights: modelInsights }, validExec)
  assert.ok(saveRes.message.includes('成功保存 1 条候选经验'))

  // 4. 调用 list 查看待审核条目
  const listRes = await executeDreamTool({ action: 'list' })
  assert.ok(listRes.message.includes('共找到 1 条经验（状态: candidate）'))
  assert.ok(listRes.message.includes('要求所有测试在本地跑通后才能提交'))

  // 从列表提取 shortId
  const match = listRes.message.match(/\[([0-9a-f]{8})\]/)
  assert.ok(match)
  const shortId = match[1]

  // 5. 调用 show 查看详情
  const showRes = await executeDreamTool({ action: 'show', id: shortId })
  assert.ok(showRes.message.includes('经验详情'))
  assert.ok(showRes.message.includes('要求所有测试在本地跑通后才能提交'))

  // 6. 调用 confirm 确认
  const confirmRes = await executeDreamTool({ action: 'confirm', id: shortId })
  assert.ok(confirmRes.message.includes('已成功确认经验'))

  // 再次 list 默认 candidate，应该为空
  const listCandidateAgain = await executeDreamTool({ action: 'list', status: 'candidate' })
  assert.ok(listCandidateAgain.message.includes('当前没有状态为 "candidate" 的经验条目'))

  // list confirmed，应该有 1 条
  const listConfirmed = await executeDreamTool({ action: 'list', status: 'confirmed' })
  assert.ok(listConfirmed.message.includes('共找到 1 条经验（状态: confirmed）'))
})

// ---------------------------------------------------------------- 九、经验向长期记忆受控晋升（Step 3C 闭环）
test('13. resolvePromotionTarget：经验类型与业务分类到长期记忆目标的映射规则', () => {
  // 1. 表达/沟通习惯 -> body/voice-learned.md
  const voiceTarget = resolvePromotionTarget({ category: 'communication', type: 'observation', statement: 'xxx' })
  assert.equal(voiceTarget.ok, true)
  assert.equal(voiceTarget.target, 'voice')
  assert.equal(voiceTarget.file, 'body/voice-learned.md')

  // 2. 稳定客观事实 -> facts.md
  const factTarget = resolvePromotionTarget({ category: 'general', type: 'fact', statement: 'xxx' })
  assert.equal(factTarget.ok, true)
  assert.equal(factTarget.target, 'facts')
  assert.equal(factTarget.file, 'facts.md')

  // 3. 工作流与操作准则 -> notebook.md
  const noteTarget1 = resolvePromotionTarget({ category: 'workflow', type: 'observation', statement: 'xxx' })
  assert.equal(noteTarget1.ok, true)
  assert.equal(noteTarget1.target, 'notebook')
  assert.equal(noteTarget1.file, 'notebook.md')

  const noteTarget2 = resolvePromotionTarget({ category: 'environment', type: 'inference', statement: 'xxx' })
  assert.equal(noteTarget2.ok, true)
  assert.equal(noteTarget2.target, 'notebook')
  assert.equal(noteTarget2.file, 'notebook.md')

  // 4. 假设型认知（hypothesis）防御：未经充分验证，拦截晋升！
  const hypothesisTarget = resolvePromotionTarget({ category: 'workflow', type: 'hypothesis', statement: 'xxx' })
  assert.equal(hypothesisTarget.ok, false)
  assert.equal(hypothesisTarget.reason, 'unverified-hypothesis')
})

test('14. promoteInsight 预览阶段（commit: false）：只读回显，不改动任何记忆或经验文件', () => {
  const root = tmp()

  // 存入一条已确认经验
  saveInsights(root, [{ category: 'workflow', type: 'observation', statement: '每次修改后运行全量测试' }])
  const items = readInsights(root).items
  const target = items[0]
  updateInsightStatus(root, target.id, 'confirm')

  // 记录文件快照
  const factsBefore = readFacts(root)
  const notebookBefore = readNotebook(root)
  const voiceBefore = readVoiceLearned(root)

  // 默认 preview (commit: false)
  const previewRes = promoteInsight(root, target.id, { commit: false })
  assert.equal(previewRes.ok, true)
  assert.equal(previewRes.isPreview, true)
  assert.ok(previewRes.message.includes('【经验晋升预览】'))
  assert.ok(previewRes.message.includes('notebook.md'))
  assert.ok(previewRes.message.includes('commit=true'))

  // 核心断言：预览阶段磁盘长期记忆与状态文件必须 100% 毫无变动
  assert.equal(readFacts(root), factsBefore)
  assert.equal(readNotebook(root), notebookBefore)
  assert.equal(readVoiceLearned(root), voiceBefore)
  assert.equal(readInsights(root).items[0].status, 'confirmed')
})

test('15. promoteInsight 审核资格拦截：未确认的 candidate 或已驳回的 rejected 经验坚决拒绝晋升', () => {
  const root = tmp()

  saveInsights(root, [
    { category: 'workflow', type: 'observation', statement: '条目 1 - 待审' },
    { category: 'communication', type: 'observation', statement: '条目 2 - 驳回' },
  ])

  const items = readInsights(root).items
  const candidateItem = items.find((it) => it.statement.includes('条目 1'))
  const rejectedItem = items.find((it) => it.statement.includes('条目 2'))
  updateInsightStatus(root, rejectedItem.id, 'reject', { reason: '不符合事实' })

  // 1. candidate 尝试晋升 -> 拦截
  const resCandidate = promoteInsight(root, candidateItem.id, { commit: true })
  assert.equal(resCandidate.ok, false)
  assert.equal(resCandidate.reason, 'unconfirmed-not-promotable')

  // 2. rejected 尝试晋升 -> 拦截
  const resRejected = promoteInsight(root, rejectedItem.id, { commit: true })
  assert.equal(resRejected.ok, false)
  assert.equal(resRejected.reason, 'rejected-not-promotable')
})

test('16. promoteInsight 显式提交（commit: true）：长期记忆准确写入、状态推进至 promoted、记录晋升时间与目标', () => {
  const root = tmp()

  // 存入 3 种不同分类的经验并全部人工确认
  saveInsights(root, [
    { category: 'communication', type: 'observation', statement: '习惯用简练语言' },
    { category: 'general', type: 'fact', statement: '操作系统是 Windows 11' },
    { category: 'workflow', type: 'observation', statement: '按模块连续实施' },
  ])

  const currentItems = readInsights(root).items
  for (const it of currentItems) {
    updateInsightStatus(root, it.id, 'confirm')
  }

  // 1. 晋升 communication -> voice-learned.md
  const voiceItem = currentItems.find((it) => it.category === 'communication')
  const rVoice = promoteInsight(root, voiceItem.id, { commit: true })
  assert.equal(rVoice.ok, true)
  assert.equal(rVoice.committed, true)
  assert.ok(readVoiceLearned(root).includes('习惯用简练语言'))

  // 2. 晋升 fact -> facts.md
  const factItem = currentItems.find((it) => it.type === 'fact')
  const rFact = promoteInsight(root, factItem.id, { commit: true })
  assert.equal(rFact.ok, true)
  assert.ok(readFacts(root).includes('操作系统是 Windows 11'))

  // 3. 晋升 workflow -> notebook.md
  const noteItem = currentItems.find((it) => it.category === 'workflow')
  const rNote = promoteInsight(root, noteItem.id, { commit: true })
  assert.equal(rNote.ok, true)
  assert.ok(readNotebook(root).includes('按模块连续实施'))

  // 检查状态均已流转为 promoted 并记录了归宿与时间戳
  const itemsAfter = readInsights(root).items
  for (const it of itemsAfter) {
    assert.equal(it.status, 'promoted')
    assert.ok(it.promotedAt)
    assert.ok(it.promotedTo)
  }
})

test('17. promoteInsight 幂等防重：重复提交安全成功，绝不在记忆文件中生成重复行', () => {
  const root = tmp()

  saveInsights(root, [{ category: 'workflow', type: 'observation', statement: '不可生成重复记忆行' }])
  const targetId = readInsights(root).items[0].id
  updateInsightStatus(root, targetId, 'confirm')

  // 首次提交
  const res1 = promoteInsight(root, targetId, { commit: true })
  assert.equal(res1.ok, true)
  assert.equal(res1.committed, true)

  const notebookAfterFirst = readNotebook(root)
  const matchesFirst = notebookAfterFirst.split('\n').filter((l) => l.includes('不可生成重复记忆行'))
  assert.equal(matchesFirst.length, 1)

  // 第二次重复提交（已处于 promoted 状态）
  const res2 = promoteInsight(root, targetId, { commit: true })
  assert.equal(res2.ok, true)
  assert.equal(res2.alreadyPromoted, true)

  // 核心断言：notebook.md 中该行依然只有 1 条，绝无重复行
  const notebookAfterSecond = readNotebook(root)
  const matchesSecond = notebookAfterSecond.split('\n').filter((l) => l.includes('不可生成重复记忆行'))
  assert.equal(matchesSecond.length, 1)
})

test('18. promoteInsight 故障恢复与重试安全：模拟记忆已写入但状态未更新的异常中途故障，重试时安全完成状态推进且不二次追加', () => {
  const root = tmp()

  const stmt = '模拟中途断电故障测试'
  saveInsights(root, [{ category: 'workflow', type: 'observation', statement: stmt }])
  const targetId = readInsights(root).items[0].id
  updateInsightStatus(root, targetId, 'confirm')

  // 模拟中途故障路径：长期记忆文件 notebook.md 已写入，但 insights.json 更新前进程中断退出
  appendNotebook(root, stmt)
  assert.ok(readNotebook(root).includes(stmt))
  // 此时 insights.json 中的状态依然停留在 confirmed
  assert.equal(readInsights(root).items[0].status, 'confirmed')

  // 用户发起重试
  const retryRes = promoteInsight(root, targetId, { commit: true })
  assert.equal(retryRes.ok, true)
  assert.equal(retryRes.committed, true)

  // 核心断言 1：状态成功自愈推进为 promoted
  assert.equal(readInsights(root).items[0].status, 'promoted')

  // 核心断言 2：长期记忆 notebook.md 中依然严格只有 1 条，重试未发生二次追加！
  const matches = readNotebook(root).split('\n').filter((l) => l.includes(stmt))
  assert.equal(matches.length, 1)
})

test('19. heart_dream 工具执行层集成 action="promote"：包含预览与显式提交完整流程', async () => {
  const root = tmp()

  const executeDreamTool = async (args) => {
    const action = String((args && args.action) || 'reflect').trim().toLowerCase()
    if (action === 'promote') {
      const id = String((args && args.id) || '').trim()
      if (!id) return { message: '请提供要晋升的经验条目 ID' }
      const commit = Boolean(args && args.commit)
      const res = promoteInsight(root, id, { commit })
      return { message: res.message }
    }
    return { message: 'other action' }
  }

  saveInsights(root, [{ category: 'general', type: 'fact', statement: '项目使用 Node 原生测试套件' }])
  const targetId = readInsights(root).items[0].id
  updateInsightStatus(root, targetId, 'confirm')

  // 1. 默认预览
  const previewMsg = await executeDreamTool({ action: 'promote', id: targetId.slice(0, 8) })
  assert.ok(previewMsg.message.includes('【经验晋升预览】'))
  assert.ok(previewMsg.message.includes('facts.md'))
  assert.ok(previewMsg.message.includes('commit=true'))
  assert.equal(readFacts(root).includes('项目使用 Node 原生测试套件'), false)

  // 2. 显式提交
  const commitMsg = await executeDreamTool({ action: 'promote', id: targetId.slice(0, 8), commit: true })
  assert.ok(commitMsg.message.includes('已成功将经验'))
  assert.ok(commitMsg.message.includes('事实记忆（facts.md）'))
  assert.equal(readFacts(root).includes('项目使用 Node 原生测试套件'), true)
})

test('20. Dream 经验生命周期与分区日志审计：验证 reflect、save、confirm、promote 全程在 dream.log 与 memory.log 中留下结构化追踪', () => {
  const root = tmp()

  // 1. saveInsights -> 记录 dream.log
  saveInsights(root, [{ category: 'communication', type: 'observation', statement: '偏好代码直接落地' }])
  const targetId = readInsights(root).items[0].id

  const dreamLogs1 = readModuleLogs(root, 'dream')
  assert.ok(dreamLogs1.some((l) => l.action === 'save_insights_success'))

  // 2. updateInsightStatus confirm -> 记录 dream.log
  updateInsightStatus(root, targetId, 'confirm')
  const dreamLogs2 = readModuleLogs(root, 'dream')
  assert.ok(dreamLogs2.some((l) => l.action === 'insight_confirm_success'))

  // 3. promoteInsight -> 记录 dream.log 与 memory.log
  promoteInsight(root, targetId, { commit: true })
  const dreamLogs3 = readModuleLogs(root, 'dream')
  assert.ok(dreamLogs3.some((l) => l.action === 'promote_commit_success'))

  const memoryLogs = readModuleLogs(root, 'memory')
  assert.ok(memoryLogs.some((l) => l.action === 'append_voice_learned'))
})


