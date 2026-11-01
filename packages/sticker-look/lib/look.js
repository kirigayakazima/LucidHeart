// 纯逻辑：认格式、查库、抽帧拼联系表、拼提示词、组装返回值。
// 不 import 任何 @deepseek-ai/*，可以脱离 DSH 直接跑测试。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isGif, parseGif } from './gif.js'
import { makeSheet } from './sheet.js'

export function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** magic bytes → { format, animated } */
export function sniff(bytes) {
  if (isGif(bytes)) return { format: 'gif', animated: true }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length >= 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', animated: buf.indexOf(Buffer.from('acTL')) > 0 }
  }
  if (buf.length >= 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { format: 'jpeg', animated: false }
  if (buf.length >= 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { format: 'webp', animated: buf.indexOf(Buffer.from('ANIM')) > 0 }
  }
  return { format: 'unknown', animated: false }
}

/** 从 README 里读 `- run.gif —— 踢水瓶…` 这种一行一条，按文件名建索引 */
export function parseLibraryText(text, out = new Map()) {
  const lineRe = /^\s*[-*]\s+(\S+?)\s*(?:——|—|--)\s*(.+?)\s*$/
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(lineRe)
    if (!m) continue
    const name = m[1].replace(/[`*]/g, '').trim()
    if (!/\.(gif|png|jpe?g|webp)$/i.test(name)) continue
    out.set(name.toLowerCase(), m[2].trim())
  }
  return out
}

/** 扫库目录（最多 4 层）里的 md，合成 文件名→含义 */
export function readLibrary(dir, { maxDepth = 4 } = {}) {
  const found = new Map()
  const walk = (d, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (/\.md$/i.test(e.name)) {
        try {
          parseLibraryText(fs.readFileSync(full, 'utf8'), found)
        } catch {
          // 单份 md 坏了不影响别的
        }
      }
    }
  }
  walk(dir, 0)
  return found
}

/** 库里没有这张时，别让模型下结论。改这句之前先读 train-usage 那段教训。 */
export const PROMPT_HEAD =
  '你在替一个人看她收到的图或表情包。画面事实是你真看到的；情绪和意思是猜的——这两件事分开说。'

export function buildPrompt({ source, sheet, timing, known, context, question }) {
  const facts = []
  if (sheet) {
    facts.push(
      `这是同一个动画里按时间均匀抽出的 ${sheet.sampled.length} 个瞬间，按从左到右、从上到下排列；` +
        '相邻格子之间有动作空档，不是几张不同的图。格序与帧号、停留时长的对照如下：' +
        sheet.sampled.map((s, i) => `第${i + 1}格=帧${s.index}/${s.ms}ms`).join('、') +
        '。',
    )
  }
  if (timing) {
    const n = timing.frames.length
    facts.push(
      `原件 ${timing.width}x${timing.height}，共 ${n} 帧，全长约 ${(timing.totalMs / 1000).toFixed(1)} 秒` +
        `${n ? `，平均每帧 ${Math.round(timing.totalMs / n)} ms` : ''}` +
        `${timing.loop === 0 ? '，无限循环' : ''}。`,
    )
  }
  if (source.format === 'webp' && source.animated) facts.push('这是动图 WebP，这里看到的可能只是第一帧。')
  if (source.format === 'png' && source.animated) facts.push('这是 APNG，这里看到的可能只是第一帧。')

  const lines = [PROMPT_HEAD, '', `【图】${facts.length ? facts.join('') : '单张静态图。'}`]

  if (known) {
    lines.push(
      `【库里有这张】她写过：${known.meaning}。以她写的为准——你只核对画面是不是还跟这条对得上` +
        '（有没有换版本、加了字）。对不上就直说哪里对不上。',
    )
  } else {
    lines.push('【库里有这张】没有。第一次见，或者换了名字，没有任何约定可查。')
  }
  if (context) lines.push(`【他发的语境】${context}`)
  if (question) lines.push(`【她想问】${question}`)

  lines.push(
    '',
    '按三段回答，不加标题、不客套：',
    '画面：只写看得见的——谁、在哪、什么动作、动作怎么变化；图上的字逐字抄，不翻译不润色。',
    '  描述顺序用「第1格、第2格」；上面已经给过对应帧号，别去读格子上的角标数字，也别自己推算帧号。',
    '意思：给 1–2 个候选解读，每个附一句依据；然后分开写「能确定的」和「不能确定的」。',
    '  画面上的表情不等于他要表达的情绪：很多人拿低头、望窗外的图表示开心，别因为画面阴就判负面。',
    '一句话：语境够了（他说过这张是什么心情、或用在什么场合）就直接给结论，别用"拿不准"糊过去；' +
      '语境不够才写「拿不准：A 或 B，要看他当时在聊什么」。',
    '',
    '看不清、太糊、字太小就直接说。不许为了给答案而编。',
  )
  return lines.join('\n')
}

/**
 * 读图前的准备：认格式、查库、抽帧、拼提示词。不碰任何 DSH 服务。
 * 返回 { ok:true, … } 或 { ok:false, message }。
 */
export function prepareLook(config, args) {
  const image = String(args?.image || '').trim()
  if (!image) return { ok: false, message: '需要给一张图的路径（本地绝对路径）。' }

  const file = expandHome(image)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { ok: false, message: `找不到这个文件：${file}` }
  }
  if (!stat.isFile()) return { ok: false, message: `这不是文件：${file}` }
  if (stat.size > config.maxBytes) {
    return {
      ok: false,
      message: `图太大（${(stat.size / 1024 / 1024).toFixed(1)} MB），超过上限 ${(config.maxBytes / 1024 / 1024).toFixed(0)} MB。`,
    }
  }

  const bytes = fs.readFileSync(file)
  const format = sniff(bytes)

  let known = null
  if (config.library) {
    try {
      const meaning = readLibrary(expandHome(config.library)).get(path.basename(file).toLowerCase())
      if (meaning) known = { file, meaning }
    } catch {
      known = null
    }
  }

  // 便宜路径：只查旧笔记，不花一次视觉调用。
  if (args?.cheap === true) {
    if (!known) return { ok: false, message: `库里没有 ${path.basename(file)} 的笔记。` }
    return { ok: true, cheapText: `库里写着 ${path.basename(file)}：${known.meaning}（没看图，便宜路径）` }
  }

  let timing = null
  let sheet = null
  let sheetBytes = bytes
  let sheetPath = file
  let sheetMedia = format.format === 'jpeg' ? 'image/jpeg' : `image/${format.format}`

  if (format.format === 'gif' && format.animated) {
    try {
      timing = parseGif(bytes)
      if (timing.frames.length > 1) {
        sheet = makeSheet(timing, {
          maxFrames: Math.max(1, Math.min(36, Number(args?.frames) || config.frames || 9)),
          cols: config.cols || 3,
        })
        sheetBytes = sheet.png
        sheetMedia = 'image/png'
        sheetPath = path.join(
          config.outDir ? expandHome(config.outDir) : os.tmpdir(),
          `${path.basename(file, path.extname(file))}-sheet-${Date.now()}.png`,
        )
        fs.mkdirSync(path.dirname(sheetPath), { recursive: true })
        fs.writeFileSync(sheetPath, sheet.png)
      }
    } catch (err) {
      return {
        ok: false,
        message: `GIF 解码失败：${err instanceof Error ? err.message : String(err)}。别退回看第一帧，先换一张或报给我。`,
      }
    }
  }

  const prompt = buildPrompt({
    source: format,
    sheet,
    timing,
    known,
    context: args?.context ? String(args.context) : null,
    question: args?.question ? String(args.question) : null,
  })

  return { ok: true, file, format, known, timing, sheet, prompt, sheetPath, sheetMedia, sheetBytes }
}

/** 组装工具返回值：不出现 undefined（宿主按 lossless JSON 校验，undefined 会判 invalid）。 */
export function buildResult({ text, prep, how }) {
  const out = { message: text, how }
  if (prep?.sheet && prep.sheetPath) out.sheet = prep.sheetPath
  return out
}

/**
 * 从识别出的文字、库内已知含义或对话语境中，提取契合 Heart Protocol v1 的表情包意图。
 * Heart 0.20.0 service.js 当前映射:
 * - 'funny' | 'laugh' => cheerful (why: '有趣的互动表情包')
 * - 'comfort' | 'hug' | 'love' | 'praise' => cheerful (why: '收到来自外部的安慰或亲近表情包')
 * - 其余 => 'interaction'
 */
export function inferStickerMeaning(text = '', known = '', context = '') {
  const combined = `${text} ${known} ${context}`.toLowerCase()
  if (/抱抱|安慰|摸摸|喜欢|爱你|亲亲|夸夸|心疼|辛苦|好棒|真好|温暖|贴贴|hug|love|comfort|praise/.test(combined)) {
    return 'comfort'
  }
  if (/哈哈|搞笑|好笑|大笑|笑死|逗|幽默|滑稽|欢乐|开心|乐呵|乐子|funny|laugh|lol/.test(combined)) {
    return 'funny'
  }
  return 'interaction'
}
