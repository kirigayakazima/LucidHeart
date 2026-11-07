import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Artifacts } from '../lib/artifacts.js'

test('cache adopts old files, expires songs, evicts oldest first, and skips active jobs and links', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-artifact-test-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'out')
  const artifacts = new Artifacts(root, { maxBytes: 16 })
  const now = Date.now()
  const day = 86_400_000
  function put(file, age = 0) {
    const full = path.join(root, file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, Buffer.alloc(4))
    fs.utimesSync(full, (now - age) / 1000, (now - age) / 1000)
    return full
  }
  const active = artifacts.begin('sing_active')
  const expired = put('song_expired.mp3', 8 * day)
  const oldest = put('sing_old/song_old.mp3', 3 * day)
  const fresh = put('song_fresh.mp3', day)
  const activeSong = put('sing_active/song_active.mp3', 8 * day)
  const weight = put('sing_old/model.onnx', 8 * day)
  const index = put('sing_old/voice.mobile.index', 8 * day)
  const outside = put('../outside/dry.wav', 8 * day)
  fs.symlinkSync(path.dirname(outside), path.join(root, 'sing_link'), 'junction')
  artifacts.sweep(undefined, now)
  for (const file of [expired, oldest]) assert.equal(fs.existsSync(file), false)
  for (const file of [fresh, activeSong, weight, index, outside]) assert.equal(fs.existsSync(file), true)
  assert.equal(artifacts.scan(root).find(entry => entry.path === fresh).ttlMs, 7 * day)
  assert.equal(artifacts.id(fresh), new Artifacts(root).id(fresh))
  artifacts.finish(active)
})

test('job cleanup discards dry audio, chunks and the duplicate mix WAV while retaining the MP3', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-artifact-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const artifacts = new Artifacts(root)
  const job = artifacts.begin('sing_cleanup')
  const output = path.join(job, 'song_cleanup.mp3')
  const chunks = path.join(job, '.work_rvc', 'chunks')
  fs.mkdirSync(chunks, { recursive: true })
  for (const file of [output, path.join(job, 'song_cleanup.wav'), path.join(job, 'dry.wav'),
    path.join(chunks, 'chunk_0000.wav')]) fs.writeFileSync(file, 'audio')
  artifacts.cleanJob(job, output, true)
  artifacts.finish(job)
  assert.deepEqual(fs.readdirSync(job), ['song_cleanup.mp3'])
})
