// dsh-sticker-look 的 host 半边：注册一个工具，把「抽帧 + 语义读图」压成一次调用。
// 准备逻辑在 ./look.js（零 @deepseek-ai 依赖，可脱离 DSH 自检），这里只做接线和模型调用。
import path from 'node:path'
import { buildResult, prepareLook, inferStickerMeaning } from './look.js'

let defineTool = (t) => t
try {
  const dt = await import('@deepseek-ai/dsh-tools')
  if (typeof dt.defineTool === 'function') defineTool = dt.defineTool
} catch {}

let z = null
try {
  const zm = await import('@deepseek-ai/schemastery')
  z = zm.default || zm
} catch {}

export const name = 'dsh-sticker-look'

/** 服务名写进 inject 才能拿到实例（同生态插件实测结论）。 */
export const inject = ['tools']

export const Config = z
  ? z.object({
      /** 视觉模型；留空则只抽帧、把提示词交回给主模型，不自己调模型。 */
      vision: z.object({
        provider: z.string().default(''),
        model: z.string().default(''),
        /** 会思考的模型要留足；太小会「没返回文字」。 */
        maxTokens: z.number().default(3000),
        timeoutMs: z.number().default(120000),
      }),
      /** 默认一次抽几帧 / 几列。 */
      frames: z.number().default(9),
      cols: z.number().default(3),
      /** 表情包库目录，读里面的 md 当"这张我认识"的约定。留空 = 不读。 */
      library: z.string().default('~/.dsh/stickers'),
      /** 输入文件上限（字节）。 */
      maxBytes: z.number().default(32 * 1024 * 1024),
      /** 联系表输出目录，留空 = 系统临时目录。 */
      outDir: z.string().default(''),
      /** 是否向 Heart Protocol v1 汇报感知事实以驱动情绪微调。 */
      observeHeart: z.boolean().default(true),
    })
  : undefined

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      message: { type: 'string', required: true },
      how: { type: 'string' },
      sheet: { type: 'string' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

/** 图进了视觉模型之后：把流收成文字，失败说清楚。 */
async function askVision({ llm, attachments, vision, prep, signal }) {
  let createUserMessage, BlockAssembler
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    createUserMessage = mod.createUserMessage
    BlockAssembler = mod.BlockAssembler
  } catch {
    createUserMessage = (args) => args
    BlockAssembler = class {
      constructor() { this._blocks = [] }
      push(chunk) { this._blocks.push({ type: 'text', text: chunk }) }
      get finish() { return { kind: 'stop' } }
      blocks() { return this._blocks }
    }
  }
  const ref = await attachments.saveImage({
    data: new Uint8Array(prep.sheetBytes),
    mediaType: prep.sheetMedia,
    name: path.basename(prep.file),
  })
  const message = createUserMessage({
    content: [
      { type: 'image', attachment: ref },
      { type: 'text', text: prep.prompt },
    ],
    source: { kind: 'plugin', plugin: 'dsh-sticker-look' },
  })
  const assembler = new BlockAssembler()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), vision.timeoutMs)
  try {
    for await (const chunk of llm.stream({
      provider: vision.provider,
      model: vision.model,
      messages: [message],
      system: '你是读图助手。只描述画面里真实存在的东西；情绪和意图是猜的，要标出来，不要编。',
      maxTokens: vision.maxTokens,
      reasoningEffort: 'low',
      purpose: 'sticker-look',
      signal: signal ?? ctrl.signal,
    })) {
      assembler.push(chunk)
    }
  } finally {
    clearTimeout(timer)
  }
  const finish = assembler.finish
  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    throw new Error(`视觉模型调用失败：${finish.failure?.message ?? '未知原因'}`)
  }
  const text = assembler
    .blocks()
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim()
  if (!text) {
    const detail = finish ? `finish=${JSON.stringify(finish).slice(0, 200)}` : 'no-finish'
    const blocks = assembler.blocks().map((b) => b.type).join(',') || 'none'
    throw new Error(`视觉模型没返回文字（${detail} blocks=${blocks}）。如果是会思考的模型，把 maxTokens 调大。`)
  }
  return text
}

/**
 * 基于 Heart Protocol v1 规范，将视觉识别事实汇报给 Heart 微内核。
 * 容错原则：采用非阻塞调用并捕获所有异常，Heart 异常绝不影响看图工具正常返回结果。
 */
async function reportObservation(ctx, { meaning, summary, file, isGif = false, frames = 1, how = 'image', confidence = 0.85 }) {
  try {
    const heart = typeof ctx?.get === 'function' ? ctx.get('heart') : ctx?.heart
    if (!heart || typeof heart.observe !== 'function') return

    await heart.observe({
      type: 'sticker',
      source: 'sticker-look',
      confidence,
      evidence: {
        meaning,
        isGif,
        frames,
        how,
        file: file || '',
      },
      summary: summary ? String(summary).slice(0, 100) : '表情包视觉感知',
    })
  } catch (err) {
    console.warn('[sticker-look] heart.observe notice:', err?.message || err)
  }
}

export async function look(ctx, config, args, exec) {
  const prep = prepareLook(config, args)
  if (!prep.ok) return { message: prep.message }
  if (prep.cheapText) {
    if (config.observeHeart !== false) {
      const meaning = inferStickerMeaning('', prep.known?.meaning, args?.context)
      reportObservation(ctx, {
        meaning,
        summary: prep.cheapText,
        file: path.basename(prep.file),
        isGif: Boolean(prep.format?.animated),
        how: 'library',
        confidence: 0.9,
      })
    }
    return { message: prep.cheapText, how: 'library' }
  }

  const vision = config.vision || {}
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined

  // 没有视觉模型就退化成「抽完帧，把提示词交回去」，不假装看过。
  if (!vision.provider || !vision.model || !llm?.stream || !attachments?.saveImage) {
    return buildResult({
      text:
        '抽好了，但没配视觉模型，我没法自己看。\n' +
        `图：${prep.sheetPath}\n` +
        '拿这张图跑一次 qqbot_describe_image，prompt 用下面这段：\n' +
        prep.prompt,
      prep,
      how: 'sheet-only',
    })
  }

  try {
    const text = await askVision({ llm, attachments, vision, prep, signal: exec?.signal })
    const how = prep.sheet ? `animation:${prep.sheet.sampled.length}/${prep.timing?.frames.length ?? '?'}f` : 'image'

    if (config.observeHeart !== false) {
      const meaning = inferStickerMeaning(text, prep.known?.meaning, args?.context)
      reportObservation(ctx, {
        meaning,
        summary: text,
        file: path.basename(prep.file),
        isGif: Boolean(prep.sheet),
        frames: prep.sheet?.sampled?.length || 1,
        how,
        confidence: 0.85,
      })
    }

    return buildResult({ text, prep, how })
  } catch (err) {
    return { message: `读图出错：${err instanceof Error ? err.message : String(err)}` }
  }
}

export function apply(ctx, config) {
  const resolved = { ...config, vision: config?.vision || {} }

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'sticker_look',
        description:
          '看清一张图/一个表情包到底在说什么。动图先抽帧拼联系表，再按「画面事实 → 候选意思 → 一句话」读出来。' +
          '收到 GIF 表情包、梗图、看不懂的截图时用它，不要直接 read_image（GIF 只会给你第一帧，容易把"踢到脚疼得跳"看成"小跑"）。' +
          '库里有的图会带上她写的约定；库里没有时它不会直接下结论，而是让你补语境。',
        parameters: {
          image: { type: 'string', description: '本地图片的绝对路径（gif/png/jpg/webp）。' },
          context: {
            type: 'string',
            description: '他发这张时的语境，比如"刚聊完一件开心的事，他说在下班路上"。这一个字段比 question 有用。',
          },
          question: { type: 'string', description: '她想问什么，比如"这是不是在笑话我"。可省略。' },
          cheap: { type: 'boolean', description: 'true = 只看库里有没有这张的约定，不调模型。' },
          frames: { type: 'number', description: '动图抽几帧，默认按配置（9）。' },
        },
        output: textOutput,
        async execute(args, exec) {
          return look(ctx, resolved, args, exec)
        },
      }),
    ),
  )
}
