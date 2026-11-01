// 自检：不连 DSH、不调模型，只验解码 / 联系表 / 库笔记 / 提示词 / 返回值形状。
// 手机上默认路径就能跑；别的机器用环境变量覆盖：LIB=… GIF=… node test/selfcheck.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrompt, buildResult, parseLibraryText, prepareLook, readLibrary, sniff, inferStickerMeaning } from '../lib/look.js'
import { parseGif } from '../lib/gif.js'
import { makeSheet, sampleIndexes } from '../lib/sheet.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const fixture = path.join(root, 'test', 'fixtures', 'move.gif')
const still = path.join(root, 'test', 'fixtures', 'still.png')
const lib = process.env.LIB || '/root/.dsh/stickers'

const config = {
  frames: 9,
  cols: 3,
  library: '',
  maxBytes: 32 * 1024 * 1024,
  outDir: path.join(root, 'test', 'tmp'),
}
fs.mkdirSync(config.outDir, { recursive: true })

let failed = 0
let skipped = 0
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`)
  else {
    failed++
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

console.log('[sniff]')
ok(sniff(fs.readFileSync(fixture)).format === 'gif', 'GIF 认成 gif')
ok(sniff(fs.readFileSync(still)).format === 'png', 'PNG 认成 png')

console.log('[decode]')
const gif = parseGif(fs.readFileSync(fixture))
ok(gif.width === 96 && gif.height === 64, '画布尺寸', `${gif.width}x${gif.height}`)
ok(gif.frames.length === 8, '帧数', `${gif.frames.length}`)
ok(gif.totalMs === 900, '总时长（80+120+80+160+80+100+200+80）', `${gif.totalMs} ms`)
ok(gif.delays.join(',') === '80,120,80,160,80,100,200,80', '逐帧时长', gif.delays.join(','))
const f0 = gif.frames[0]
const px = (x, y) => [...f0.subarray((y * gif.width + x) * 4, (y * gif.width + x) * 4 + 4)]
ok(px(10, 20)[0] > 180 && px(10, 20)[1] < 100, '第 0 帧红块位置正确', px(10, 20).join(','))

console.log('[sample]')
ok(sampleIndexes(8, 9).length === 8, '要 9 帧只有 8 帧时全给')
ok(sampleIndexes(55, 9).length === 9, '长动图刚好 9 个采样点', sampleIndexes(55, 9).join(','))
ok(sampleIndexes(8, 1).length === 1 && sampleIndexes(8, 1)[0] === 0, '单帧采样 (8, 1) 不产生 NaN')
ok(sampleIndexes(1, 1).length === 1 && sampleIndexes(1, 1)[0] === 0, '单帧采样 (1, 1) 正确返回 [0]')

console.log('[heart: 意图推断]')
ok(inferStickerMeaning('好搞笑的表情', '', '') === 'funny', '推断 funny 意图')
ok(inferStickerMeaning('给你一个抱抱安慰', '', '') === 'comfort', '推断 comfort 意图')
ok(inferStickerMeaning('风景图打卡', '', '') === 'interaction', '常规图推断 interaction 意图')

console.log('[sheet]')
const sheet = makeSheet(gif, { maxFrames: 4, cols: 2 })
ok(sheet.sampled.length === 4, '抽 4 帧', sheet.sampled.map((s) => s.index).join(','))
ok(sheet.png.subarray(1, 4).toString() === 'PNG', '产出真的是 PNG')
ok(sheet.width > 0 && sheet.height > 0, '尺寸', `${sheet.width}x${sheet.height}`)

console.log('[prepare: 动图]')
const p1 = prepareLook(config, { image: fixture, question: '他是不是在笑我' })
ok(p1.ok, '准备成功', p1.ok ? '' : p1.message)
ok(p1.sheet && fs.existsSync(p1.sheetPath), '联系表落盘')
ok(p1.prompt.includes('同一个动画') && p1.prompt.includes('候选解读'), '提示词含动图事实与候选要求')
ok(p1.prompt.includes('库里有这张】没有'), '库里没有时要明说')
ok(p1.prompt.includes('拿不准'), '给了不许下结论的出口')
ok(p1.prompt.includes('第1格=帧'), '提示词给了格序→帧号对照')
ok(p1.prompt.includes('别去读格子上的角标'), '禁止模型自己数角标')
const withLabels = makeSheet(gif, { maxFrames: 2, cols: 2, labels: true }).png
const noLabels = makeSheet(gif, { maxFrames: 2, cols: 2, labels: false }).png
ok(!withLabels.equals(noLabels), '联系表默认画帧号角标')

console.log('[prepare: 静态图]')
const p2 = prepareLook(config, { image: still })
ok(p2.ok && p2.prompt.includes('单张静态图'), '静态图走单图提示词')
ok(!p2.sheet && p2.sheetPath === still, '静态图不造联系表')

console.log('[返回值形状]')
const withSheet = JSON.stringify(buildResult({ text: 'x', prep: p1, how: 'animation' }))
const noSheet = JSON.stringify(buildResult({ text: 'x', prep: p2, how: 'image' }))
ok(!withSheet.includes('undefined') && !noSheet.includes('undefined'), '不出现 undefined（宿主会判 invalid）')
ok(JSON.parse(noSheet).sheet === undefined, '静态图不带 sheet 字段')

console.log('[失败要说清楚]')
const missing = prepareLook(config, { image: path.join(root, 'nope.gif') })
ok(!missing.ok && missing.message.includes('找不到'), '文件不存在')
const bad = prepareLook(config, { image: path.join(root, 'test', 'fixtures', 'broken.gif') })
fs.writeFileSync(path.join(root, 'test', 'fixtures', 'broken.gif'), Buffer.from('GIF89a\x00\x01', 'latin1'))
const bad2 = prepareLook(config, { image: path.join(root, 'test', 'fixtures', 'broken.gif') })
fs.unlinkSync(path.join(root, 'test', 'fixtures', 'broken.gif'))
ok(!bad2.ok && bad2.message.includes('别退回看第一帧'), '坏文件不退回第一帧')

console.log('[提示词：已知]')
const knownPrompt = buildPrompt({ source: { format: 'gif', animated: true }, known: { meaning: '开心时用' }, context: '刚聊完开心的事' })
ok(knownPrompt.includes('以她写的为准'), '有笔记时以笔记为准')
ok(knownPrompt.includes('刚聊完开心的事'), '带上了语境')
ok(!knownPrompt.includes('【库里有这张】没有'), '有笔记时不说不认识')

console.log('[库解析]')
const parsed = parseLibraryText('- run.gif —— 踢水瓶\n- http-200.jpg -- 成了')
ok(parsed.get('run.gif') === '踢水瓶' && parsed.get('http-200.jpg') === '成了', '两种分隔符都认')
if (fs.existsSync(lib)) {
  const live = readLibrary(lib)
  ok(live.size >= 1, `真库读得到（${lib}）`, `${live.size} 条`)
} else {
  skipped++
  console.log(`  skip 没有库目录：${lib}`)
}

console.log('[透明索引回归]')
// 手工造一张 1x1、透明索引=255 的 GIF。GCE 里 transIdx 读错一位就会把透明像素画成不透明，
// 真实表情包里这种坑出现在 run.gif 第 27 帧（整块变黑）。
function craftGif(transIdx, packed) {
  const pack = (codes, width) => {
    const bytes = []
    let acc = 0
    let n = 0
    for (const c of codes) {
      acc |= c << n
      n += width
      while (n >= 8) {
        bytes.push(acc & 0xff)
        acc >>>= 8
        n -= 8
      }
    }
    if (n > 0) bytes.push(acc & 0xff)
    return Buffer.from(bytes)
  }
  const data = pack([256, transIdx, 257], 9)
  const gct = Buffer.alloc(768)
  gct[255 * 3] = 255 // 索引 255 是红色
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([1, 0, 1, 0, 0xf7, 0, 0]),
    gct,
    Buffer.from([0x21, 0xf9, 0x04, packed, 0x01, 0x00, transIdx, 0x00]),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x08]),
    Buffer.concat([Buffer.from([data.length]), data, Buffer.from([0])]),
    Buffer.from([0x3b]),
  ])
}
const transparent = parseGif(craftGif(255, 0x05))
ok(transparent.frames[0][3] === 0, '透明索引 255 的像素保持透明（读错一位会变红）')
const opaque = parseGif(craftGif(255, 0x04))
ok(opaque.frames[0][0] === 255 && opaque.frames[0][3] === 255, '没设透明标记时照样画出来')

console.log('[无外部依赖]')
const pureFiles = ['gif.js', 'sheet.js', 'look.js']
const pureSrc = pureFiles.map((f) => fs.readFileSync(path.join(root, 'lib', f), 'utf8')).join('\n')
const imports = [...pureSrc.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
ok(
  imports.every((m) => m.startsWith('node:') || m.startsWith('.')),
  '解码/拼图/逻辑只用 node: 内置与相对路径',
  imports.join(','),
)

console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}${skipped ? `（跳过 ${skipped} 项）` : ''}`)
process.exit(failed ? 1 : 0)
