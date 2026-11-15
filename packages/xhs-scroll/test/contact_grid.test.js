import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as engine from '../../../../dsh-video-storyboard/src/storyboard/sheet.js'
import { imageTokens } from '../../../../dsh-video-storyboard/src/storyboard/plan.js'
import { contactGrid, decodeCell } from '../lib/contact_grid.js'
import { apply } from '../lib/index.js'

test('six real PNGs make one 768-square 384-budget contact sheet with yellow numbered cells', async () => {
  const source = await engine.encodePngBuffer(Buffer.alloc(48 * 32 * 3, 128), 48, 32)
  const grid = await contactGrid(Array(6).fill('image'), { engine, loadImage: async () => source })
  assert.deepEqual([grid.width, grid.height, grid.tokenCost], [768, 768, 384])
  assert.deepEqual(grid.numbered, [1, 2, 3, 4, 5, 6])
  assert(imageTokens(grid.width, grid.height) <= grid.tokenCost)
  assert.deepEqual([grid.png.readUInt32BE(16), grid.png.readUInt32BE(20)], [768, 768])
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
    { input: grid.png, maxBuffer: 2 * 1024 * 1024 })
  const pixel = (x, y) => [...raw.subarray((y * 768 + x) * 3, (y * 768 + x) * 3 + 3)]
  assert(pixel(9, 9)[0] > 200 && pixel(265, 265)[0] > 200)
  assert(pixel(14, 14)[0] < 50, 'dark opening bracket is printed over the yellow badge')
  assert(pixel(521, 521)[0] < 100, 'unused cell has no badge')
})

test('failed images keep original cell numbers and excess images are never downloaded', async () => {
  const loaded = []
  const grid = await contactGrid(Array.from({ length: 11 }, (_, i) => i), {
    engine, async loadImage(url) { loaded.push(url); if (url === 1) throw Error('unavailable'); return url },
    decode: (_, size) => Buffer.alloc(size * size * 3, 100),
  })
  assert.deepEqual(loaded, [0, 1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(grid.numbered, [1, 3, 4, 5, 6, 7, 8, 9])
})

test('two sources use a 2-by-2 layout and all failed sources return text-only', async () => {
  const sizes = []
  const grid = await contactGrid(['a', 'b'], { engine, loadImage: async () => null,
    decode: (_, size) => { sizes.push(size); return Buffer.alloc(size * size * 3) } })
  assert.deepEqual(sizes, [384, 384])
  assert.deepEqual(grid.numbered, [1, 2])
  assert.equal(await contactGrid(['a'], { engine, loadImage: async () => { throw Error('unavailable') } }), null)
})

test('decoder rejects untrusted playlist data before invoking FFmpeg', () => {
  assert.throws(() => decodeCell(Buffer.from('#EXTM3U\nhttps://host/file'), 256), /unsupported_image/)
})

test('xhs_read saves one encoded attachment and renders it exactly once', async () => {
  const url = 'https://xhslink.com/a/shared'
  const images = ['https://x.xhscdn.com/1.png', 'https://x.xhscdn.com/2.png']
  const png = await engine.encodePngBuffer(Buffer.alloc(32 * 48 * 3, 100), 32, 48)
  const attachment = { id: 'fixture-attachment' }
  const tools = new Map(), saved = []
  apply({ tools: { register: tool => tools.set(tool.name, tool) },
    attachments: { async saveImage(spec) { saved.push(spec); return attachment } } }, {}, {
    engine, client: {
      async read() { return { ok: true, note: { title: '共享笔记', images } } },
      async image() { return png },
    },
  })
  const exec = { callId: 'call', agent: { session: { events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: url }] } },
    { type: 'tool/call', data: { turn: 1, callId: 'call' } },
  ] } } }
  const tool = tools.get('xhs_read')
  const result = await tool.execute({ url }, exec)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.deepEqual([saved[0].data.readUInt32BE(16), saved[0].data.readUInt32BE(20)], [768, 768])
  const [description, visual, ...extra] = tool.output.render({ url }, result)
  assert.deepEqual(visual, { type: 'image', attachment })
  assert.equal(extra.length, 0)
  assert.equal(JSON.parse(description.text).tokenCost, 384)
  assert(!description.text.includes('xhscdn'))
})
