import { spawn } from 'node:child_process'

export const GRID_SIZE = 768
export const GRID_TOKENS = 384
export const MAX_IMAGES = 9

function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png_pipe'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg_pipe'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp_pipe'
  throw new Error('unsupported_image')
}

export function decodeCell(bytes, size, { signal, ffmpeg = 'ffmpeg' } = {}) {
  const format = imageFormat(bytes)
  const length = size * size * 3
  const filter = `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x121214,setsar=1`
  const child = spawn(ffmpeg, ['-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'pipe', '-threads', '1',
    '-max_pixels', '25000000', '-f', format, '-i', 'pipe:0', '-an', '-frames:v', '1', '-filter_threads', '1',
    '-vf', filter, '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
  })
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    child.stdout.on('data', chunk => {
      received += chunk.length
      if (received > length) child.kill()
      else chunks.push(chunk)
    })
    child.stdin.on('error', () => {})
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0 && received === length) resolve(Buffer.concat(chunks, length))
      else reject(new Error('image_decode_failed'))
    })
    child.stdin.end(bytes)
  })
}

function brackets(engine, sheet, x, y, scale) {
  const { buffer, width, height } = sheet
  const mark = (left, top, w, h) => engine.fillRect(buffer, width, height, left, top, w, h, [38, 32, 0])
  for (const edge of [x, x + 9 * scale]) {
    mark(edge, y, scale, 7 * scale)
    const left = edge === x ? x : edge - scale
    mark(left, y, 2 * scale, scale)
    mark(left, y + 6 * scale, 2 * scale, scale)
  }
}

export async function contactGrid(sources, { engine, loadImage, decode = decodeCell, signal, ffmpeg } = {}) {
  const urls = sources.slice(0, MAX_IMAGES)
  if (!urls.length) return null
  const columns = urls.length === 1 ? 1 : urls.length <= 4 ? 2 : 3
  const size = GRID_SIZE / columns
  const frames = [], numbered = []
  for (const [position, url] of urls.entries()) {
    signal?.throwIfAborted()
    const index = position + 1
    try {
      const buffer = await decode(await loadImage(url, signal), size, { signal, ffmpeg })
      if (buffer.length !== size * size * 3) throw new Error('invalid_cell')
      frames.push({ buffer, index, w: size, h: size })
      numbered.push(index)
    } catch {
      signal?.throwIfAborted()
      frames.push(null)
    }
  }
  if (!numbered.length) return null
  const sheet = engine.composeSheet({ frames, cols: columns, rows: columns, cellAspect: 1,
    gutter: 0, budget: GRID_SIZE ** 2, burn: 'none' })
  if (sheet.width !== GRID_SIZE || sheet.height !== GRID_SIZE) throw new Error('invalid_grid_size')
  for (const index of numbered) {
    const x = ((index - 1) % columns) * size + 8, y = Math.floor((index - 1) / columns) * size + 8
    engine.fillRect(sheet.buffer, sheet.width, sheet.height, x, y, 32, 26, [255, 220, 65], .86)
    brackets(engine, sheet, x + 6, y + 6, 2)
    engine.drawGlyphs(sheet.buffer, sheet.width, sheet.height, String(index), x + 11, y + 6, 2, [38, 32, 0])
  }
  const png = await engine.encodePngBuffer(sheet.buffer, sheet.width, sheet.height, { ffmpegPath: ffmpeg })
  signal?.throwIfAborted()
  return { png, width: sheet.width, height: sheet.height, numbered, tokenCost: GRID_TOKENS }
}
