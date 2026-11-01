// 零依赖联系表：抽帧 → 面积平均缩放 → 拼格 → 手写 PNG 编码（只用 node:zlib）。
// 单帧与整帧解码都做过逐像素比对；PNG 由 PIL 读回验证过。
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 面积平均缩放；透明像素按白底混合，避免深色底上看不出轮廓。 */
export function downscale(src, sw, sh, dw, dh, bg = 255) {
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * sw + sx) * 4
          const a = src[o + 3] / 255
          r += src[o] * a + bg * (1 - a)
          g += src[o + 1] * a + bg * (1 - a)
          b += src[o + 2] * a + bg * (1 - a)
          n++
        }
      }
      const o = (y * dw + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = 255
    }
  }
  return out
}

/** 均匀采样帧号：要 n 个就取 n 个，不会因为四舍五入少给。 */
export function sampleIndexes(total, want) {
  const n = Math.max(1, Math.min(want, total))
  if (n <= 1) return [0]
  if (n === total) return Array.from({ length: total }, (_, i) => i)
  const picked = []
  for (let i = 0; i < n; i++) picked.push(Math.round((i * (total - 1)) / (n - 1)))
  return [...new Set(picked)]
}

/** 5x7 点阵数字：给每格标帧号，不带字体文件依赖。 */
const GLYPHS = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

function putPx(canvas, W, H, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const o = (y * W + x) * 4
  canvas[o] = r
  canvas[o + 1] = g
  canvas[o + 2] = b
  canvas[o + 3] = 255
}

/** 画帧号：白字 + 一圈黑边，深浅底都看得见。 */
function stamp(canvas, W, H, ox, oy, text) {
  const draw = (dx, dy, r, g, b) => {
    let cx = ox + dx
    for (const ch of String(text)) {
      const glyph = GLYPHS[ch]
      if (glyph) {
        for (let y = 0; y < 7; y++) {
          for (let x = 0; x < 5; x++) {
            if (glyph[y][x] === '1') putPx(canvas, W, H, cx + x, oy + dy + y, r, g, b)
          }
        }
      }
      cx += 6
    }
  }
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1], [-1, -1]]) draw(dx, dy, 16, 16, 16)
  draw(0, 0, 245, 245, 245)
}

/**
 * 拼一张联系表。
 * 返回 { png, width, height, sampled:[{index,ms}], cols }。
 */
export function makeSheet(gif, { maxFrames = 9, cols = 3, maxEdge = 320, gap = 6, bg = 245, labels = true } = {}) {
  const indexes = sampleIndexes(gif.frames.length, maxFrames)
  const c = Math.min(cols, indexes.length)
  const rows = Math.ceil(indexes.length / c)
  const scale = Math.min(1, maxEdge / Math.max(gif.width, gif.height))
  const fw = Math.max(1, Math.round(gif.width * scale))
  const fh = Math.max(1, Math.round(gif.height * scale))
  const W = c * fw + (c + 1) * gap
  const H = rows * fh + (rows + 1) * gap
  const canvas = Buffer.alloc(W * H * 4, bg)
  for (let i = 3; i < canvas.length; i += 4) canvas[i] = 255

  indexes.forEach((frameIndex, i) => {
    const cell = downscale(gif.frames[frameIndex], gif.width, gif.height, fw, fh, bg)
    const ox = gap + (i % c) * (fw + gap)
    const oy = gap + Math.floor(i / c) * (fh + gap)
    for (let y = 0; y < fh; y++) {
      cell.copy(canvas, ((oy + y) * W + ox) * 4, y * fw * 4, (y + 1) * fw * 4)
    }
    if (labels) stamp(canvas, W, H, ox + 3, oy + 3, frameIndex)
  })

  return {
    png: encodePng(W, H, canvas),
    width: W,
    height: H,
    cols: c,
    sampled: indexes.map((index) => ({ index, ms: gif.delays[index] })),
  }
}
