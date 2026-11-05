import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { faultDetails, installRuntimeDiagnostics } from '../lib/runtime-diagnostics.js'
import { apply } from '../lib/index.js'

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-runtime-'))
const read = (dir, name = 'runtime.jsonl') => fs.readFileSync(path.join(dir, 'logs', name), 'utf8').trim().split('\n').map(JSON.parse)

test('fatal monitoring records evidence and preserves the real nonzero process exit', () => {
  const dir = root()
  const module = new URL('../lib/runtime-diagnostics.js', import.meta.url).href
  const program = `import { installRuntimeDiagnostics } from ${JSON.stringify(module)};
installRuntimeDiagnostics(${JSON.stringify(dir)});
throw new Error('cannot get property "heart" without inject');`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot get property/)
  const events = read(dir)
  assert.equal(events[0].event, 'loaded')
  assert.ok(events.some(x => x.event === 'sample' && x.rssBytes > 0))
  assert.ok(events.some(x => x.event === 'fatal' && x.kind === 'cordis-uninjected-service' && x.service === 'heart'))
  assert.ok(events.some(x => x.event === 'exit' && x.code === 1))
  assert.equal(read(dir, 'runtime-faults.jsonl')[0].kind, 'cordis-uninjected-service')
})

test('fault evidence excludes message contents and URL query credentials', () => {
  const details = faultDetails({ name: 'Error', message: 'private-conversation SECRET_123', stack:
    'Error: private-conversation SECRET_123\n    at convert (file:///plugin/index.js?token=SECRET_123:456:8:2)' }, 'uncaughtException')
  assert.ok(!JSON.stringify(details).includes('SECRET_123'))
  assert.deepEqual(details.sites, ['file:///plugin/index.js:8:2'])
  assert.equal(faultDetails(null, 'uncaughtException').errorClass, 'Error')
})

test('runtime samples rotate within a fixed budget and disposer removes timer/listeners', async () => {
  const dir = root()
  const before = process.listenerCount('uncaughtExceptionMonitor')
  const stop = installRuntimeDiagnostics(dir, { intervalMs: 2, maxBytes: 600 })
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before + 1)
  await new Promise(resolve => setTimeout(resolve, 180))
  stop()
  stop()
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before)
  const files = fs.readdirSync(path.join(dir, 'logs')).filter(x => x.startsWith('runtime.jsonl'))
  assert.deepEqual(files.sort(), ['runtime.jsonl', 'runtime.jsonl.1', 'runtime.jsonl.2'])
  for (const file of files) assert.ok(fs.statSync(path.join(dir, 'logs', file)).size <= 600)
  const saved = fs.readFileSync(path.join(dir, 'logs/runtime.jsonl'), 'utf8')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fs.readFileSync(path.join(dir, 'logs/runtime.jsonl'), 'utf8'), saved)
})

test('Heart load/unload/reload restores collection without duplicate process listeners', () => {
  const dir = root()
  const before = process.listenerCount('uncaughtExceptionMonitor')
  const start = () => {
    const cleanups = []
    apply({ effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
      tools: { register() {} } }, { root: dir, pulse: false, injectPrompt: false })
    return () => cleanups.reverse().forEach(fn => fn())
  }
  start()()
  start()()
  assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before)
  const events = read(dir)
  assert.equal(events.filter(x => x.event === 'loaded').length, 2)
  assert.equal(events.filter(x => x.event === 'sample').length, 2)
  assert.equal(events.filter(x => x.event === 'unloaded').length, 2)
  assert.notEqual(events.filter(x => x.event === 'loaded')[0].id, events.filter(x => x.event === 'loaded')[1].id)
})

test('unwritable evidence never throws or alters the runtime', () => {
  const file = path.join(root(), 'blocked')
  fs.writeFileSync(file, 'keep')
  const stop = installRuntimeDiagnostics(file)
  assert.doesNotThrow(stop)
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep')
})
