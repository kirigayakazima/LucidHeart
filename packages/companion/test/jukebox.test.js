import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { execution, fixture, host } from './fixture.js'

test('jukebox serializes synthesis and reopens a completed artifact into history', async t => {
  const calls = []
  const f = fixture(t, { dispatch: async song => {
    calls.push(song.id)
    return { ok: true, job_id: song.id, expected_output: path.join(f.dataDir, `song_${song.id}.mp3`) }
  } })
  const [first, second] = await Promise.all([f.music.add('a', { title: '第一首' }), f.music.add('a', { title: '第二首' })])
  assert.equal(first.status, 'synthesizing')
  assert.equal(second.status, 'queued')
  assert.deepEqual(calls, [first.id])
  writeFileSync(first.output_path, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(150)]))
  const { music, tasks } = f.reopen()
  assert.equal((await music.history('a'))[0].status, 'ready')
  assert.equal(tasks.get(first.task_id).status, 'completed')
  assert.equal((await music.next('a')).next.id, second.id)
  assert.equal((await music.history('a'))[0].status, 'played')
})

test('jukebox validates pitch, records dispatch failure, and keeps queues scoped', async t => {
  const f = fixture(t, { dispatch: async () => null })
  await assert.rejects(f.music.add('a', { title: 'A', pitch: -2 }), /音高/)
  const failed = await f.music.add('a', { title: 'A', pitch: -4 })
  assert.equal(failed.status, 'failed')
  assert.equal(f.tasks.get(failed.task_id).status, 'failed')
  assert.deepEqual((await f.music.list('b')).queue, [])
})

test('Cordis forwards RVC request with original agent, root, signal, and nesting token', async t => {
  const exec = execution('唱一首樱花草')
  const h = host(t, {}, call => {
    assert.equal(call.name, 'rvc_sing')
    assert.equal(call.agent, exec.agent)
    assert.equal(call.parent, exec.token)
    assert.equal(call.rootCallId, exec.rootCallId)
    assert.equal(call.signal, exec.signal)
    assert.deepEqual(call.arguments, { song_title: '樱花草', pitch: -4 })
    return { isError: false, value: { ok: true, job_id: 'rvc-1', expected_output: path.resolve('not-present/song_rvc-1.mp3') } }
  })
  const { data } = await h.run('jukebox_add', { title: '樱花草', pitch: -4 }, exec)
  assert.equal(data.rvc_task_id, 'rvc-1')
})

test('jukebox reconciles expired synthesis without discarding the next queue item', async t => {
  const f = fixture(t, { dispatch: async song => ({
    ok: true, job_id: song.id, expected_output: path.join(f.dataDir, `song_${song.id}.mp3`),
  }) })
  const first = await f.music.add('a', { title: 'A' })
  const next = await f.music.add('a', { title: 'B' })
  f.advance(31 * 60_000)
  assert.equal((await f.music.next('a')).next.id, next.id)
  assert.equal(f.tasks.get(first.task_id).error_message, 'synthesis_timeout')
})

test('jukebox recovers the queue when the durable task has already expired', async t => {
  const f = fixture(t, { dispatch: async song => ({
    ok: true, job_id: song.id, expected_output: path.join(f.dataDir, `song_${song.id}.mp3`),
  }) })
  const first = await f.music.add('a', { title: 'A' })
  const next = await f.music.add('a', { title: 'B' })
  f.advance(86_400_000)
  const reopened = f.reopen()
  assert.equal(reopened.tasks.get(first.task_id).error_message, 'host_restarted')
  assert.equal((await reopened.music.next('a')).next.id, next.id)
})
