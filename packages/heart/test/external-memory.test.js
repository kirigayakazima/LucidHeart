import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as store from '../lib/store.js'
import { buildSelfSection, buildVoiceSection, buildMoodSection } from '../lib/prompt.js'
import { saveInsights, updateInsightStatus, promoteInsight, readInsights } from '../lib/dream.js'
import { writeSense, readSense, appendSenseLog } from '../lib/sense.js'
import { writeTrigger, readTrigger, scheduleNextIdle } from '../lib/trigger.js'

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-external-'))
const denied = fn => assert.throws(fn, { code: 'HEART_EXTERNAL_MEMORY_READ_ONLY' })
const cli = fileURLToPath(new URL('../bin/heart.js', import.meta.url))
const run = (dir, ...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HEART_ROOT: dir } })
function seed(dir) {
  store.appendFact(dir, '档案事实：旧项目地址')
  store.appendMemory(dir, 'test', '档案事件：旧部署')
  // 模拟缺来源的老 MEMORY，external 启动不得自动补写。
  const f = path.join(dir, 'MEMORY', `${store.dateOf()}.test.md`)
  fs.appendFileSync(f, '- 12:00 老条目无来源\n')
}
function archive(dir) {
  const files = ['facts.md', 'src-index.json']
  if (fs.existsSync(path.join(dir, 'MEMORY'))) files.push(...fs.readdirSync(path.join(dir, 'MEMORY')).map(f => `MEMORY/${f}`))
  return Object.fromEntries(files.filter(f => fs.existsSync(path.join(dir, f))).map(f => [f, fs.readFileSync(path.join(dir, f)).toString('base64')]))
}
function confirmed(dir, category, type, statement) {
  const saved = saveInsights(dir, [{ category, type, statement, confidence: 0.9 }], { session: 'test' })
  const id = saved.saved[0].id
  assert.equal(updateInsightStatus(dir, id, 'confirm').ok, true)
  return id
}

test('默认 legacy 仍支持事实修订/删除、MEMORY、导入和回退，不修改外部数据', () => {
  const dir = root(), externalData = path.join(dir, 'mnemon-unrelated.json')
  fs.writeFileSync(externalData, 'keep-exactly')
  assert.equal(store.readMemoryMode(dir), 'legacy')
  seed(dir)
  store.reviseFact(dir, '旧项目地址', '新的地址')
  assert.match(store.readFacts(dir), /新的地址/)
  store.discardFact(dir, '新的地址')
  const bundle = store.exportBundle(dir)
  store.writeHeartConfig(dir, { memoryMode: 'external' })
  denied(() => store.appendFact(dir, 'blocked'))
  store.writeHeartConfig(dir, { memoryMode: 'legacy' })
  store.appendFact(dir, 'rollback-write')
  store.importBundle(dir, bundle)
  assert.match(store.readFacts(dir), /rollback-write/)
  assert.equal(fs.readFileSync(externalData, 'utf8'), 'keep-exactly')
})

test('external 阻止所有存储写入口，迁移/导出也不能改旧档案', () => {
  const dir = root(); seed(dir)
  store.writeHeartConfig(dir, { memoryMode: 'external' })
  const before = archive(dir)
  for (const fn of [
    () => store.appendFact(dir, 'new'), () => store.appendMemory(dir, 'test', 'new'),
    () => store.reviseFact(dir, '档案', 'new'), () => store.discardFact(dir, '档案'),
    () => store.reviseEntry(dir, '档案', 'new', 'fact'), () => store.discardEntry(dir, '档案', 'fact'),
    () => store.reviseEntry(dir, '', 'new', 'FACT'), () => store.discardEntry(dir, '', 'FACT'),
    () => store.recordSrcIndex(dir, 'src', 'session'),
    () => store.importBundle(dir, Buffer.from('invalid'), { force: true }),
    () => store.exportBundleToFile(dir, path.join(dir, 'facts.md')),
    () => store.exportBundleToFile(dir, path.join(dir, 'MEMORY', 'new.gz')),
    () => store.exportBundleToFile(dir, path.join(dir, 'config.json')),
  ]) denied(fn)
  assert.equal(store.migrateProvenance(dir).skipped, 'external-memory')
  assert.equal(store.migrate(dir).skipped, 'external-memory')
  const alias = path.join(dir, 'archive-alias')
  fs.symlinkSync(path.join(dir, 'MEMORY'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  denied(() => store.exportBundleToFile(dir, path.join(alias, 'new.gz')))
  store.exportBundleToFile(dir, path.join(dir, 'archive.json.gz'))
  assert.deepEqual(archive(dir), before)
})

test('external 整包导入不能借配置覆盖、路径别名或 force 绕过；拒绝前不写 Notebook', () => {
  const dir = root(); seed(dir); store.writeHeartConfig(dir, { memoryMode: 'external' })
  const before = archive(dir), notebook = store.readNotebook(dir)
  for (const name of ['facts.md', './facts.md', 'MEMORY/../facts.md', 'FACTS.MD', 'config.json']) {
    const buffer = zlib.gzipSync(JSON.stringify({ format: 'dsh-heart', files: { 'notebook.md': '- should-not-import', [name]: 'overwrite' } }))
    denied(() => store.importBundle(dir, buffer, { force: true }))
  }
  assert.deepEqual(archive(dir), before)
  assert.equal(store.readNotebook(dir), notebook)
  assert.equal(store.readMemoryMode(dir), 'external')
})

test('external 旧查询有来源标记，默认 self/prompt 无旧事实，Mood/Voice/Notebook 保留', () => {
  const dir = root(); seed(dir); store.writeHeartConfig(dir, { memoryMode: 'external' })
  const before = archive(dir)
  store.appendNotebook(dir, '修改前先备份是我的原则')
  store.appendVoiceLearned(dir, '回复先说结论')
  assert.equal(store.updateMood(dir, { state: 'engaged', intensity: 0.7, reason: 'focus' }).ok, true)
  assert.match(buildVoiceSection(dir), /回复先说结论/)
  assert.ok(buildMoodSection(dir))
  assert.match(buildSelfSection(dir, { promptFacts: true }), /我的原则/)
  assert.doesNotMatch(buildSelfSection(dir, { promptFacts: true }), /旧项目地址/)
  assert.doesNotMatch(store.readSelf(dir), /旧项目地址|旧部署/)
  const legacy = store.readSelf(dir, { includeLegacy: true })
  assert.match(legacy, /Heart 旧档案/); assert.match(legacy, /旧项目地址/)
  assert.match(store.recall(dir, '旧部署').text, /Heart 旧档案/)
  assert.deepEqual(archive(dir), before)
})

test('external Dream 拒绝 facts（即使 communication 或 selfPrinciple），保留 Voice 和受控自我原则', () => {
  const dir = root(); seed(dir); store.writeHeartConfig(dir, { memoryMode: 'external' })
  const before = archive(dir)
  for (const category of ['workflow', 'communication']) {
    const id = confirmed(dir, category, 'fact', category + '用户旧事实')
    assert.equal(promoteInsight(dir, id, { commit: true, selfPrinciple: true }).reason, 'external-memory-read-only')
    assert.equal(readInsights(dir).items.find(x => x.id === id).status, 'confirmed')
  }
  const voice = confirmed(dir, 'communication', 'observation', '沟通时先给简洁结论')
  assert.equal(promoteInsight(dir, voice, { commit: true }).ok, true)
  const principle = confirmed(dir, 'workflow', 'observation', '我在修改前先核对上下文')
  assert.equal(promoteInsight(dir, principle, { commit: true }).reason, 'self-principle-required')
  assert.equal(promoteInsight(dir, principle, { selfPrinciple: true }).isPreview, true)
  assert.equal(promoteInsight(dir, principle, { commit: true, selfPrinciple: true }).ok, true)
  assert.match(store.readNotebook(dir), /我在修改前/)
  assert.deepEqual(archive(dir), before)
})

test('external CLI 与直接 API 同样拒写；新根不创建 facts/MEMORY，坏配置不开放写权限', () => {
  const dir = root()
  assert.equal(run(dir, 'mode', 'external').status, 0)
  store.ensureLayout(dir)
  assert.equal(fs.existsSync(path.join(dir, 'facts.md')), false)
  assert.equal(fs.existsSync(path.join(dir, 'MEMORY')), false)
  assert.equal(run(dir, 'write', '-k', 'fact', 'blocked').status, 1)
  assert.equal(run(dir, 'write', '-k', 'memory', 'blocked').status, 1)
  assert.equal(run(dir, 'write', '-k', 'FACT', 'blocked').status, 1)
  assert.equal(run(dir, 'write', '-k', 'notebook', 'self principle').status, 0)
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken')
  denied(() => store.appendFact(dir, 'fail-open'))
  assert.equal(store.readHeartConfig(dir).memoryMode, 'external')
  assert.throws(() => store.writeHeartConfig(dir, { memoryMode: 'typo' }))
})

test('external 的 Body、Sense、Trigger 和 pulse 状态可用，不创建通用记忆', () => {
  const dir = root(); store.writeHeartConfig(dir, { memoryMode: 'external' }); store.ensureLayout(dir)
  assert.ok(store.readBody(dir, 'hands'))
  writeSense(dir, { at: new Date().toISOString(), presence: 'present', idleMs: 0 })
  appendSenseLog(dir, readSense(dir))
  assert.equal(readSense(dir).presence, 'present')
  writeTrigger(dir, { lastEvent: 'test' })
  assert.equal(readTrigger(dir).lastEvent, 'test')
  assert.ok(scheduleNextIdle(dir, 30).nextIdleAt)
  assert.equal(store.pulseTick(dir).ticks, 1)
  assert.equal(store.stats(dir).memoryFiles, 0)
  assert.equal(fs.existsSync(path.join(dir, 'MEMORY')), false)
})
