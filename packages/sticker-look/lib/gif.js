// 零依赖 GIF 解码：LZW + 局部帧合成 + disposal/透明/隔行。
// 与 Pillow 逐像素比对过（8 帧变时长 / 带透明 / 带偏移的局部帧），不依赖 sharp / omggif / ffmpeg。
export function isGif(buf) {
  if (buf.length < 6) return false
  const head = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5])
  return head === 'GIF87a' || head === 'GIF89a'
}

function readSubBlocks(buf, pos) {
  const chunks = []
  for (;;) {
    if (pos >= buf.length) break
    const n = buf[pos++]
    if (n === 0) break
    chunks.push(buf.subarray(pos, pos + n))
    pos += n
  }
  return { data: Buffer.concat(chunks), pos }
}

function lzwDecode(minCodeSize, data, expected) {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  let codeSize = minCodeSize + 1
  let next = eoi + 1
  let dict = []
  const reset = () => {
    dict = new Array(4096)
    for (let i = 0; i < clear; i++) dict[i] = [i]
    next = eoi + 1
    codeSize = minCodeSize + 1
  }
  reset()

  const out = new Uint8Array(expected)
  let op = 0
  let bitBuf = 0
  let bitCnt = 0
  let prev = null

  for (let i = 0; i < data.length; i++) {
    bitBuf |= data[i] << bitCnt
    bitCnt += 8
    while (bitCnt >= codeSize) {
      const code = bitBuf & ((1 << codeSize) - 1)
      bitBuf >>>= codeSize
      bitCnt -= codeSize

      if (code === clear) {
        reset()
        prev = null
        continue
      }
      if (code === eoi) return out

      let entry
      if (code < next && dict[code] !== undefined) entry = dict[code]
      else if (code === next && prev !== null) entry = [...prev, prev[0]]
      else throw new Error(`GIF LZW 码越界：${code}（next=${next}）`)

      for (const v of entry) if (op < out.length) out[op++] = v
      if (prev !== null && next < 4096) {
        dict[next++] = [...prev, entry[0]]
        if (next === 1 << codeSize && codeSize < 12) codeSize++
      }
      prev = entry
    }
  }
  return out
}

function deinterlace(src, width, height) {
  const order = []
  for (let y = 0; y < height; y += 8) order.push(y)
  for (let y = 4; y < height; y += 8) order.push(y)
  for (let y = 2; y < height; y += 4) order.push(y)
  for (let y = 1; y < height; y += 2) order.push(y)
  const out = new Uint8Array(width * height * 4)
  order.forEach((dst, i) => out.set(src.subarray(i * width * 4, (i + 1) * width * 4), dst * width * 4))
  return out
}

/** 解出每一帧合成后的 RGBA（画布尺寸），以及每帧停留时长。 */
export function parseGif(buf) {
  if (!isGif(buf)) throw new Error('不是 GIF')
  let pos = 6
  const width = buf.readUInt16LE(pos)
  const height = buf.readUInt16LE(pos + 2)
  const packed = buf[pos + 4]
  const bgIndex = buf[pos + 5]
  pos += 7

  let gct = null
  if (packed & 0x80) {
    const n = 2 ** ((packed & 0x07) + 1)
    gct = buf.subarray(pos, pos + n * 3)
    pos += n * 3
  }

  const frames = []
  const delays = []
  const disposals = []
  let loop = null
  let gce = null
  const canvas = new Uint8Array(width * height * 4)

  for (;;) {
    if (pos >= buf.length) break
    const b = buf[pos++]
    if (b === 0x3b) break

    if (b === 0x21) {
      const label = buf[pos++]
      if (label === 0xf9) {
        const size = buf[pos]
        const p = buf[pos + 1]
        const delayCs = buf.readUInt16LE(pos + 2)
        const transIdx = buf[pos + 4] // size(1) + packed(1) + delay(2) 之后才是透明色索引
        pos += 1 + size
        pos++ // terminator
        gce = {
          disposal: (p >> 2) & 0x07,
          transparent: p & 0x01 ? transIdx : null,
          delayMs: delayCs * 10,
        }
      } else if (label === 0xff) {
        const size = buf[pos++]
        const app = buf.toString('ascii', pos, pos + size)
        pos += size
        const sub = readSubBlocks(buf, pos)
        pos = sub.pos
        if (app.startsWith('NETSCAPE') && sub.data.length >= 3 && sub.data[0] === 1) {
          loop = sub.data.readUInt16LE(1)
        }
      } else {
        const size = buf[pos++]
        pos += size
        pos = readSubBlocks(buf, pos).pos
      }
      continue
    }

    if (b !== 0x2c) throw new Error(`GIF 块结构异常：0x${b.toString(16)}`)

    const left = buf.readUInt16LE(pos)
    const top = buf.readUInt16LE(pos + 2)
    const fw = buf.readUInt16LE(pos + 4)
    const fh = buf.readUInt16LE(pos + 6)
    const ipacked = buf[pos + 8]
    pos += 9

    let palette = gct
    if (ipacked & 0x80) {
      const n = 2 ** ((ipacked & 0x07) + 1)
      palette = buf.subarray(pos, pos + n * 3)
      pos += n * 3
    }
    if (palette === null) throw new Error('GIF 没有调色板')

    const minCodeSize = buf[pos++]
    const sub = readSubBlocks(buf, pos)
    pos = sub.pos

    const px = lzwDecode(minCodeSize, sub.data, fw * fh)
    const transparent = gce?.transparent ?? null
    if (process.env.GIF_DEBUG) {
      const hist = new Map()
      for (const v of px) hist.set(v, (hist.get(v) ?? 0) + 1)
      const top3 = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      console.error(
        `[gif] frame#${frames.length} rect=${left},${top},${fw}x${fh} lct=${!!(ipacked & 0x80)} ` +
          `il=${!!(ipacked & 0x40)} min=${minCodeSize} data=${sub.data.length}B trans=${transparent} disp=${gce?.disposal} ` +
          `topIdx=${top3.map(([k, v]) => `${k}:${v}`).join(' ')}`,
      )
    }
    let quad = new Uint8Array(fw * fh * 4)
    for (let i = 0; i < fw * fh; i++) {
      const idx = px[i]
      if (transparent !== null && idx === transparent) continue
      const o = i * 4
      quad[o] = palette[idx * 3]
      quad[o + 1] = palette[idx * 3 + 1]
      quad[o + 2] = palette[idx * 3 + 2]
      quad[o + 3] = 255
    }
    if (ipacked & 0x40) quad = deinterlace(quad, fw, fh)

    const disposal = gce?.disposal ?? 0
    const before = disposal === 3 ? canvas.slice() : null

    for (let y = 0; y < fh; y++) {
      const cy = top + y
      if (cy < 0 || cy >= height) continue
      for (let x = 0; x < fw; x++) {
        const cx = left + x
        if (cx < 0 || cx >= width) continue
        const so = (y * fw + x) * 4
        if (quad[so + 3] === 0) continue
        const do_ = (cy * width + cx) * 4
        canvas[do_] = quad[so]
        canvas[do_ + 1] = quad[so + 1]
        canvas[do_ + 2] = quad[so + 2]
        canvas[do_ + 3] = 255
      }
    }

    frames.push(canvas.slice())
    delays.push(gce?.delayMs ?? 0)
    disposals.push(disposal)

    if (disposal === 2) {
      for (let y = top; y < top + fh; y++) {
        for (let x = left; x < left + fw; x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          canvas.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 4)
        }
      }
    } else if (disposal === 3 && before !== null) {
      canvas.set(before)
    }
    gce = null
  }

  return {
    width,
    height,
    loop,
    bgIndex,
    frames,
    delays,
    disposals,
    totalMs: delays.reduce((a, b) => a + b, 0),
  }
}
