import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  appendFact,
  appendMemory,
  appendNotebook,
  canSpeak,
  consumeSpeak,
  enqueueSay,
  inQuietHours,
  readOutbox,
  takeSay,
  writeSpeak,
  dateOf,
  detectBodyProfile,
  discardFact,
  discardNotebook,
  ensureLayout,
  exportBundle,
  exportBundleToFile,
  importBundle,
  migrate,
  migrateProvenance,
  oneLine,
  PULSE_MAX_LINES,
  pulseTick,
  readBody,
  readProfile,
  readPulse,
  readSelf,
  recall,
  reviseFact,
  reviseNotebook,
  safeDevice,
  shortSessionId,
  kindFromSessionText,
  viaOfSourceKind,
  traceSrc,
  readSrcIndex,
  SCHEMA_VERSION,
  stats,
} from '../lib/store.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-test-'))

test('首次布局：本子是空的，器官装好，身体按宿主判定', () => {
  const root = tmp()
  const s = stats(root)
  assert.equal(s.notebookEntries, 0)
  assert.deepEqual(s.organs.sort(), ['hands', 'rhythm', 'senses', 'voice'])
  assert.ok(['win', 'phone', 'linux'].includes(s.body))
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'schema.json'), 'utf8')).version, SCHEMA_VERSION)
})

test('环境判定：显式 > 环境变量 > 自动探测', () => {
  assert.equal(detectBodyProfile({ explicit: 'phone', platform: 'win32' }), 'phone')
  assert.equal(detectBodyProfile({ env: { DSH_HEART_BODY: 'linux' }, platform: 'win32' }), 'linux')
  assert.equal(detectBodyProfile({ env: {}, platform: 'win32' }), 'win')
  // Linux + 宿主写了桥凭据 → 手机容器
  const base = tmp()
  const heart = path.join(base, '.dsh', 'heart')
  fs.mkdirSync(heart, { recursive: true })
  fs.writeFileSync(path.join(base, '.dsh', '.bridge_headers'), 'x', 'utf8')
  assert.equal(detectBodyProfile({ env: {}, platform: 'linux', dir: heart }), 'phone')
  assert.equal(detectBodyProfile({ env: {}, platform: 'linux', dir: tmp() }), 'linux')
})

test('两套身体内容不同，都写明自己住在哪', () => {
  const phone = tmp()
  ensureLayout(phone, { explicit: 'phone' })
  assert.match(readBody(phone, 'hands'), /住在手机上/)
  assert.equal(readProfile(phone).profile, 'phone')

  const win = tmp()
  ensureLayout(win, { explicit: 'win' })
  assert.match(readBody(win, 'hands'), /住在 Windows 电脑上/)
  assert.equal(readProfile(win).profile, 'win')
})

test('换环境不会静默覆盖：旧手保留为 hands.md.previous', () => {
  const root = tmp()
  ensureLayout(root, { explicit: 'phone' })
  ensureLayout(root, { explicit: 'win' })
  assert.match(readBody(root, 'hands'), /Windows/)
  assert.ok(fs.existsSync(path.join(root, 'body', 'hands.md.previous')))
  assert.match(fs.readFileSync(path.join(root, 'body', 'hands.md.previous'), 'utf8'), /手机上/)
})

test('本子：可写、可改、可弃用', () => {
  const root = tmp()
  appendNotebook(root, '说话前先想清楚再说')
  assert.equal(stats(root).notebookEntries, 1)
  reviseNotebook(root, '说话前先想清楚', '说话前先想清楚，但别想太久')
  assert.match(fs.readFileSync(path.join(root, 'notebook.md'), 'utf8'), /别想太久/)
  discardNotebook(root, '别想太久')
  assert.equal(stats(root).notebookEntries, 0)
})

test('记忆按 日期.设备 分文件', () => {
  const root = tmp()
  const a = appendMemory(root, 'pc', '第一条')
  const b = appendMemory(root, 'phone', '第二条')
  assert.notEqual(a.file, b.file)
  assert.ok(a.file.endsWith(`${dateOf()}.pc.md`))
  assert.match(a.line, /^- \d{2}:\d{2} \[pc\] 第一条 · src:unknown via:unknown$/)
})

test('门槛：会话 id 取前 8 位，触发方式分开记', () => {
  const root = tmp()
  const src = shortSessionId('session-da5b2a27-9e0f-4312-a473-79c37b9de966')
  assert.equal(src, 'da5b2a27')
  assert.equal(shortSessionId(''), 'unknown')
  assert.equal(shortSessionId('!!!'), 'unknown')

  const out = appendMemory(root, 'pc', '有门槛的一条', new Date(), { src, via: 'chat' })
  assert.match(out.line, / · src:da5b2a27 via:chat$/)

  const self = appendMemory(root, 'pc', '空闲时写的', new Date(), { src: 'abc12345', via: 'self' })
  assert.match(self.line, / · src:abc12345 via:self$/)
})

test('脏出处/脏触发方式一律降级成 unknown', () => {
  const root = tmp()
  const dirty = appendMemory(root, 'pc', '脏出处', new Date(), { src: 'abc def\n第二行', via: 'whatever' })
  assert.match(dirty.line, / · src:unknown via:unknown$/)
  const bare = appendMemory(root, 'pc', '只给出处', new Date(), 'abc12345')
  assert.match(bare.line, / · src:abc12345 via:unknown$/)
})

test('旧记忆补 unknown：只加标记，不改正文，幂等', () => {
  const root = tmp()
  ensureLayout(root)
  const file = path.join(root, 'MEMORY', `${dateOf()}.pc.md`)
  fs.writeFileSync(file, '- 22:09 [pc] 老的一条\n- 22:10 [pc] 老的两条\n', 'utf8')

  const first = migrateProvenance(root)
  assert.equal(first.lines, 2)
  const body = fs.readFileSync(file, 'utf8')
  assert.match(body, /^- 22:09 \[pc\] 老的一条 · src:unknown via:unknown$/m)
  assert.match(body, /^- 22:10 \[pc\] 老的两条 · src:unknown via:unknown$/m)

  const second = migrateProvenance(root)
  assert.equal(second.lines, 0, '第二次不该再动')
  assert.equal(fs.readFileSync(file, 'utf8'), body)
})

test('迁移不会把已有出处覆盖成 unknown', () => {
  const root = tmp()
  appendMemory(root, 'pc', '有出处', new Date(), { src: 'keepme12', via: 'chat' })
  migrateProvenance(root)
  const body = fs.readFileSync(appendMemory(root, 'pc', '再写一条').file, 'utf8')
  assert.match(body, /src:keepme12 via:chat/)
})

test('触发方式从会话日志判断，跳过宿主注入的消息', () => {
  const line = (kind) =>
    JSON.stringify({ type: 'user/message', data: { role: 'user', source: { kind } } })
  const join = (...parts) => parts.join(String.fromCharCode(10))
  // 真实用户消息后面会跟 time-context / runtime-context / skill-catalog，跳过它们
  assert.equal(kindFromSessionText(join(line('user'), line('time-context'))), 'user')
  assert.equal(
    kindFromSessionText(join(line('schedule'), line('runtime-context'), line('time-context'))),
    'schedule',
  )
  assert.equal(kindFromSessionText(join(line('time-context'), line('skill-catalog'))), '')
  assert.equal(kindFromSessionText(''), '')
  // 被帧切断的半截行不算证据
  assert.equal(kindFromSessionText('{"type":"user/message","data":{"sour'), '')

  assert.equal(viaOfSourceKind('user'), 'chat')
  assert.equal(viaOfSourceKind('schedule'), 'self')
  assert.equal(viaOfSourceKind('time-context'), 'unknown')
})

test('门牌本：8 位能换回完整会话 id', () => {
  const root = tmp()
  appendMemory(root, 'pc', '这条有账', new Date(), {
    src: 'da5b2a27',
    via: 'chat',
    session: 'session-da5b2a27-9e0f-4312-a473-79c37b9de966',
  })
  const index = readSrcIndex(root)
  assert.equal(index['da5b2a27'].session, 'da5b2a27-9e0f-4312-a473-79c37b9de966')
  assert.equal(index['da5b2a27'].count, 1)

  appendMemory(root, 'pc', '同一个会话又写一条', new Date(), {
    src: 'da5b2a27',
    via: 'chat',
    session: 'session-da5b2a27-9e0f-4312-a473-79c37b9de966',
  })
  assert.equal(readSrcIndex(root)['da5b2a27'].count, 2)

  const hit = traceSrc(root, 'da5b')
  assert.equal(hit.session, 'da5b2a27-9e0f-4312-a473-79c37b9de966')
  assert.equal(traceSrc(root, 'zzz'), null)
  assert.equal(traceSrc(root, ''), null)
})

test('没给完整会话 id 时门牌本不写空账', () => {
  const root = tmp()
  appendMemory(root, 'pc', '没会话', new Date(), { src: 'abc12345', via: 'self' })
  assert.deepEqual(readSrcIndex(root), {})
})

test('recall 能按触发方式过滤', () => {
  const root = tmp()
  appendMemory(root, 'pc', '他说要早点睡', new Date(), { src: 'aaaa1111', via: 'chat' })
  appendMemory(root, 'pc', '我自己想到要早点睡', new Date(), { src: 'bbbb2222', via: 'self' })
  assert.equal(recall(root, '早点睡').count, 2)
  assert.equal(recall(root, '早点睡', { via: 'chat' }).count, 1)
  assert.match(recall(root, '早点睡', { via: 'chat' }).text, /他说要早点睡/)
  assert.equal(recall(root, '早点睡', { via: 'self' }).count, 1)
  assert.equal(recall(root, '早点睡', { via: 'unknown' }).count, 0)
})

test('检索命中关键词，不命中返回 0', () => {
  const root = tmp()
  appendMemory(root, 'pc', '用户偏好：回复要短')
  assert.equal(recall(root, '偏好').count, 1)
  assert.equal(recall(root, '不存在').count, 0)
})

test('readSelf：本子为空时只说它空着，不补默认人格', () => {
  const root = tmp()
  const body = readSelf(root)
  assert.match(body, /还是空的/)
  assert.doesNotMatch(body, /你是|你的名字|性格/)
})

test('readSelf：写过的本子与最近记忆都会出现', () => {
  const root = tmp()
  appendNotebook(root, '我自己决定：先给结论')
  appendMemory(root, 'pc', '今天把插件重建了')
  const body = readSelf(root)
  assert.match(body, /先给结论/)
  assert.match(body, /今天把插件重建了/)
})

test('导出包含本子/器官/记忆，导入按行并集合并', () => {
  const source = tmp()
  appendNotebook(source, '来源设备的想法')
  appendMemory(source, 'phone', '手机上的记忆')
  const payload = JSON.parse(zlib.gunzipSync(exportBundle(source)).toString('utf8'))
  assert.equal(payload.format, 'dsh-heart')
  assert.equal(payload.schema, SCHEMA_VERSION)
  assert.ok(payload.files['notebook.md'])
  assert.ok(payload.files['body/hands.md'])
  assert.equal(Object.keys(payload.files).some((k) => k.startsWith('handoff/')), false)

  const target = tmp()
  appendNotebook(target, '本机的想法')
  importBundle(target, exportBundle(source))
  const notebook = fs.readFileSync(path.join(target, 'notebook.md'), 'utf8')
  assert.match(notebook, /本机的想法/)
  assert.match(notebook, /来源设备的想法/)
})

test('导出文件可落盘并重新导入', () => {
  const root = tmp()
  appendNotebook(root, '往返测试')
  const out = exportBundleToFile(root, path.join(root, 'dump.json.gz'))
  assert.ok(out.bytes > 0)
  const again = tmp()
  importBundle(again, fs.readFileSync(out.file))
  assert.match(readSelf(again), /往返测试/)
})

test('migrate：v2 的 CORE/RELATIONSHIP 改名保留，空 handoff 目录清掉', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'handoff'), { recursive: true })
  fs.writeFileSync(path.join(root, 'CORE.md'), '# 旧的人设\n', 'utf8')
  fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify({ version: 2 }), 'utf8')
  const result = migrate(root)
  assert.equal(result.to, SCHEMA_VERSION)
  assert.ok(fs.existsSync(path.join(root, 'legacy-CORE.md')))
  assert.equal(fs.existsSync(path.join(root, 'CORE.md')), false)
  assert.equal(fs.existsSync(path.join(root, 'handoff')), false)
})

test('oneLine 压平换行；设备名限制成安全字符', () => {
  assert.equal(oneLine('a\n\nb\tc'), 'a b c')
  assert.equal(safeDevice('My Phone/1'), 'my-phone-1')
})

test('工具 schema 不使用 required: false（DSH 方言要求省略该键）', () => {
  const src = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(src.includes('required: false'), false)
})

test('旧版遗留的 hands.md（无身体标记）会被重装并保留 previous', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'body'), { recursive: true })
  fs.writeFileSync(path.join(root, 'body', 'hands.md'), '# 手\n\n住在手机上\n', 'utf8')
  ensureLayout(root, { explicit: 'win' })
  assert.match(readBody(root, 'hands'), /Windows/)
  assert.ok(fs.existsSync(path.join(root, 'body', 'hands.md.previous')))
  assert.match(fs.readFileSync(path.join(root, 'body', 'hands.md.previous'), 'utf8'), /手机上/)
})

test('事实层：写入、修改、弃用，与情节分开', () => {
  const root = tmp()
  appendFact(root, '用户希望回复简短')
  appendMemory(root, 'pc', '今天修了插件')
  assert.match(readSelf(root), /用户希望回复简短/)
  reviseFact(root, '回复简短', '用户希望回复先给结论')
  assert.match(fs.readFileSync(path.join(root, 'facts.md'), 'utf8'), /先给结论/)
  discardFact(root, '先给结论')
  assert.equal(stats(root).factEntries, 0)
  assert.equal(stats(root).memoryEntries, 1)
})

test('节律：每次醒来记一行，且有上限', () => {
  const root = tmp()
  const first = pulseTick(root)
  assert.match(first.line, /wake/)
  pulseTick(root)
  assert.equal(readPulse(root).length, 2)
  // 上限：塞满再醒一次，仍不超过上限
  const file = path.join(root, 'pulse.log')
  fs.writeFileSync(file, Array.from({ length: PULSE_MAX_LINES + 10 }, (_, i) => `x ${i}`).join('\n') + '\n')
  pulseTick(root)
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, PULSE_MAX_LINES)
})

test('安静时段跨午夜也成立', () => {
  assert.equal(inQuietHours(new Date('2026-10-20T23:30:00'), '23:00', '08:00'), true)
  assert.equal(inQuietHours(new Date('2026-10-20T07:59:00'), '23:00', '08:00'), true)
  assert.equal(inQuietHours(new Date('2026-10-20T12:00:00'), '23:00', '08:00'), false)
})

test('档位限制当日次数，跨日重置', () => {
  const root = tmp()
  writeSpeak(root, { level: 2, usedToday: 0, lastSpokeDate: null })
  const t = new Date('2026-10-20T12:00:00')
  assert.equal(canSpeak(root, t).ok, true)
  consumeSpeak(root, t)
  consumeSpeak(root, new Date('2026-10-20T12:01:00'))
  assert.equal(canSpeak(root, new Date('2026-10-20T12:02:00')).ok, false)
  // 第二天恢复
  assert.equal(canSpeak(root, new Date('2026-10-21T12:00:00')).ok, true)
})

test('待发队列先进先出', () => {
  const root = tmp()
  enqueueSay(root, '第一条')
  enqueueSay(root, '第二条')
  assert.equal(takeSay(root).text, '第一条')
  assert.equal(readOutbox(root).length, 1)
})

test('待发条目记住说这句话的窗口', () => {
  const root = tmp()
  enqueueSay(root, '在窗口 A 说的', 'delivery', 'session-aaa')
  const [item] = readOutbox(root)
  assert.equal(item.session, 'session-aaa')
  // 没给窗口的旧式条目保持原样，投递时再退回全局目标
  enqueueSay(root, '不知道在哪个窗口说的')
  assert.equal(readOutbox(root)[1].session, undefined)
})
