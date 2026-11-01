// dsh-heart 的插件入口（host 半边）。
// 只做注册：读写逻辑全部在 ./store.js，保持零 DSH 依赖，方便单测和 CLI 复用。
//
// 设计边界（重要，改代码前先读）：
//   身体（body/）由我们维护：嘴、耳朵、手 —— 可以装、可以换。
//   心（notebook.md / handoff/）只能由它自己写：这里只提供写入面，不提供默认内容。
//   所以本模块没有任何「人格设定」的字符串常量。
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pickAgent } from './target.js'
import {
  appendFact,
  appendMemory,
  appendNotebook,
  appendVoiceLearned,
  assertLegacyMemory,
  dateOf,
  discardEntry,
  ensureLayout,
  exportBundleToFile,
  importBundle,
  migrate,
  readBody,
  readNotebook,
  canSpeak,
  consumeSpeak,
  enqueueSay,
  readHeartConfig,
  readMemoryMode,
  LEGACY_ARCHIVE_NOTICE,
  writeHeartConfig,
  shortSessionId,
  traceSrc,
  sessionSourceKind,
  viaOfSourceKind,
  readOutbox,
  readPulse,
  readSpeak,
  takeSay,
  readSelf,
  recall,
  resolveRoot,
  reviseEntry,
  pulseTick,
  stats,
  readMood,
  updateMood,
  resetMood,
} from './store.js'
import {
  filterSessionMessages,
  parseModelInsights,
  readInsights,
  saveInsights,
  updateInsightStatus,
  promoteInsight,
} from './dream.js'
import { log } from './logger.js'
import { HeartService } from './service.js'

export { HeartService } from './service.js'
export * from '../contracts/index.js'

import {
  readSense,
  writeSense,
  appendSenseLog,
  readSenseLog,
  senseSample,
  applyPresence,
} from './sense.js'
import {
  maybeTrigger,
  readTrigger,
  scheduleNextIdle,
  recordIdleCategory,
  idleCategoryState,
  idleCategoryRemaining,
} from './trigger.js'
import { buildMoodSection, buildPromptBundle, buildSelfSection, buildVoiceSection } from './prompt.js'

export const name = 'dsh-heart'

/** 静态注入：服务必须写在这里，ctx.get() 拿不到（同生态插件的实测结论）。 */
export const inject = ['tools', 'webServer', 'agents', 'systemPrompt']

export const Config = z.object({
  /** 数据目录；留空 = ~/.dsh/heart。数据永远在插件包之外。 */
  root: z.string().default(''),
  /** 本设备标识，写进每条记忆的 [device] 标记，如 pc / phone。 */
  device: z.string().default(''),
  /** 强制指定身体：phone / win / linux。留空则按宿主环境自动判定。 */
  body: z.string().default(''),
  /** 节律：让它自己按时间醒。默认关，开了才有自己的时间线。 */
  pulse: z.boolean().default(false),
  /** 多久醒一次（秒），默认 60。测试时可以调到 30。 */
  pulseSeconds: z.number().default(60),
  /** 每轮把她的 voice/senses + 本子/事实注入系统提示。默认开。 */
  injectPrompt: z.boolean().default(true),
  /** 注入本子的最近几条。 */
  promptNotebookLines: z.number().default(6),
  /** 注入事实的最近几条。 */
  promptFactsLines: z.number().default(12),
  /** 是否注入事实。 */
  promptFacts: z.boolean().default(true),
  /** 空闲自主回合：他一阵没说话时，允许模型自己起一轮。 */
  idleTurns: z.boolean().default(true),
  /** 首次空闲回合的阈值（没有 nextIdleAt 时），默认也是最小 6 分钟。 */
  idleTurnMinutes: z.number().default(6),
  /** 两次空闲回合之间的最小间隔（也是 heart_next 的下限）。 */
  idleTurnMinMinutes: z.number().default(6),
  /** 模型没有排下一次时，兜底多少分钟后再看。 */
  idleTurnDefaultMinutes: z.number().default(30),
  /** heart_next 允许排的最大间隔。 */
  idleTurnMaxMinutes: z.number().default(180),
  /** 每天最多几次空闲回合。 */
  idleTurnDailyCap: z.number().default(6),
})

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { message: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: value.message }],
}

function trace(root, msg) {
  try {
    fs.appendFileSync(path.join(root, 'plugin-trace.log'), new Date().toISOString() + ' ' + msg + String.fromCharCode(10))
    log.core(root, 'info', 'lifecycle_trace', { msg })
  } catch {
    // 追踪不能影响加载
  }
}

export function apply(ctx, config) {
  const root = resolveRoot(config.root)
  // 宿主的 config 会被重启重写，这里以 heart/config.json 为准。
  trace(root, 'apply:start')
  config = { ...config, ...readHeartConfig(root) }
  const externalMemory = readMemoryMode(root) === 'external'
  trace(root, 'apply:config pulse=' + !!config.pulse + ' seconds=' + config.pulseSeconds)
  const device = String(config.device || process.env.DSH_HEART_DEVICE || 'agent').trim() || 'agent'

  // 首次加载建目录、按宿主环境装身体、跑迁移。注意：这里不会替它写本子。
  ctx.effect(() => {
    ensureLayout(root, { explicit: config.body })
    migrate(root)
  })

  // 注册 Heart 0.20.0 微内核服务 (Cordis Service)
  const service = new HeartService(ctx, root, config)
  ctx.effect(() => {
    if (typeof ctx.provide === 'function') {
      return ctx.provide('heart', service)
    }
  })

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_voice_learn',
        description:
          '记一条关于「对方表达偏好」或「怎么沟通更有效」的观察。必须是经过筛选的偏好（如"对方看排查过程时更倾向直接看 diff"），而不是记录整段对话、临时猜测或把偶发情况当作永久规则。',
        parameters: {
          observation: { type: 'string', description: '观察到的表达偏好，一句话，200 字以内。' },
        },
        output: textOutput,
        async execute(args) {
          const raw = args && args.observation
          const res = appendVoiceLearned(root, raw)
          if (!res.ok) {
            if (res.reason === 'duplicate') {
              return { message: '这条表达偏好之前已经记过了，不用重复记录。' }
            }
            if (res.reason === 'too-long') {
              return { message: `记录失败：内容超过 200 字上限（${res.message}）。请浓缩为一句话。` }
            }
            if (res.reason === 'empty-or-control' || res.reason === 'invalid-input') {
              return { message: '记录失败：输入内容不能为空或纯控制字符。' }
            }
            return { message: `记录失败：${res.message || res.reason}` }
          }
          return { message: `已记下表达习惯：${res.line}` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_mood',
        description:
          '当对话中发生明确的新事件（如共同完成有意义的任务、取得突破进展、受到肯定）时，更新当前表达倾向。' +
          '【严格约束】：' +
          '1. 必须有具体事实证据，严禁在普通问答、日常打招呼或用户沉默时调用；' +
          '2. 严禁为了让状态持续活跃而频繁重复调用；' +
          '3. 任务完成通常对应 engaged（专注推进）或 cheerful（轻快愉悦），只有极少数重大里程碑才使用 excited；' +
          '4. tired 仅代表表达风格舒缓简洁，只在确有持续工作证据时使用，严禁以此作为拒绝任务或推诿的理由；' +
          '5. 严禁通过此工具触发额外通知、任务调度或主动联系用户。',
        parameters: {
          state: {
            type: 'string',
            description: 'calm（平静基准）| engaged（投入专注）| cheerful（轻快愉悦）| excited（活跃兴奋）| tired（低活跃舒缓）',
          },
          intensity: {
            type: 'number',
            description: '状态影响强度，0.0 到 1.0 之间。常规轻度 0.4-0.6，显著进展 0.7-0.8。',
          },
          reason: {
            type: 'string',
            description: '触发新事件的具体原因枚举：baseline（仅限平复）| task_completed（有意义的任务完成）| positive_interaction（明确积极互动）| focus（深度专注攻坚）| deep_work（确有持续高负荷工作后的低活跃过渡）',
          },
        },
        output: textOutput,
        async execute(args) {
          try {
            const rawIntensity = args && args.intensity
            const numIntensity = typeof rawIntensity === 'number' ? rawIntensity : Number(rawIntensity)
            const prevSnapshot = service.getSnapshot()
            const res = updateMood(root, {
              state: args && args.state,
              intensity: numIntensity,
              reason: args && args.reason,
            })
            if (!res.ok) {
              return { message: `未更新状态：${res.message || res.reason}` }
            }
            const currentSnapshot = service.getSnapshot()
            service.notifyStateChanged(prevSnapshot, currentSnapshot, 'tool:heart_mood')
            const m = res.mood
            return { message: `已更新当前表达状态：${m.state}（强度 ${m.intensity}，原因：${m.reason}）` }
          } catch (err) {
            return { message: `更新状态失败：${err.message || String(err)}` }
          }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_self',
        description: externalMemory
          ? 'external 模式：读 Heart Notebook 自我原则。仅当需要核对旧 Heart 档案时传 includeLegacy=true，附带的旧 facts/MEMORY 为只读历史，不是当前事实；当前用户事实应查询 Mnemon。'
          : '读「你自己」：你的本子、事实和最近几天的记忆。会话开始时调用一次。本子为空时会明确告诉你它是空的。',
        parameters: {
          days: { type: 'number', description: '带最近几天的记忆，默认 3。' },
          includeLegacy: { type: 'boolean', description: 'external 模式显式读取旧 facts/MEMORY；默认不读取。返回内容仅供核对历史。' },
        },
        output: textOutput,
        async execute(args) {
          const body = readSelf(root, { days: Number(args.days) || 3, includeLegacy: args.includeLegacy === true })
          return { message: body }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_write',
        description: externalMemory
          ? 'external 模式：仅 kind=notebook 可写 Heart 自我原则；不要将用户事实或历史写入 Notebook。kind=fact/memory 已停写，必须改用 Mnemon 官方记忆工具，Heart 不代转。'
          :
          '往「你自己」里写一条。kind=notebook 写本子（你对自己的判断、规矩、改主意）；kind=fact 写事实（关于世界和对方的稳定事实，会变的就改，别往后追加第二条）；kind=memory 写情节（发生了什么，只追加，会自动带上出处：是你哪个会话里写的）。一次一条，控制在 800 字以内。',
        parameters: {
          text: { type: 'string', description: '要写下的那一件事，一句话说清。' },
          kind: {
            type: 'string',
            description: 'notebook（默认，写本子）| fact（写事实）| memory（写情节）',
          },
        },
        output: textOutput,
        async execute(args, exec) {
          const text = String(args.text || '').trim()
          if (!text) return { message: '需要写点什么' }
          const kind = String(args.kind || 'notebook')
          if (kind !== 'notebook' && readMemoryMode(root) === 'external') assertLegacyMemory(root)
          if (kind === 'memory') {
            // 门牌：哪个会话、谁起的回合。拿不到就 unknown，绝不反推。
            const caller = exec && exec.agent
            const session = caller && caller.id ? String(caller.id) : ''
            const out = appendMemory(root, device, text, new Date(), {
              src: shortSessionId(session),
              via: detectVia(exec),
              session,
            })
            return { message: `已写入情节 ${out.line}` }
          }
          if (kind === 'fact') {
            const out = appendFact(root, text)
            return { message: `已写入事实 ${out.line}` }
          }
          const out = appendNotebook(root, text)
          return { message: `已写入本子 ${out.line}` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_revise',
        description: externalMemory
          ? 'external 模式：只修订 Notebook 自我原则；target=fact 禁止修改旧档案。用户事实请使用 Mnemon 官方工具。'
          : '改本子或事实中包含 match 的条目，改成 replacement。',
        parameters: {
          match: { type: 'string', description: '要改的那条里的一段原文。' },
          replacement: { type: 'string', description: '改成什么。' },
          target: { type: 'string', description: 'notebook（默认）| fact' },
        },
        output: textOutput,
        async execute(args) {
          const result = reviseEntry(
            root,
            String(args.match || ''),
            String(args.replacement || ''),
            String(args.target || 'notebook')
          )
          return { message: result.changed ? '改好了' : '没找到匹配的那条' }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_discard',
        description: externalMemory
          ? 'external 模式：只弃用 Notebook 自我原则；target=fact 禁止删除旧档案。用户事实请使用 Mnemon 官方工具。'
          : '弃用本子或事实中包含 match 的条目。',
        parameters: {
          match: { type: 'string', description: '要删掉的那条里的一段原文。' },
          target: { type: 'string', description: 'notebook（默认）| fact' },
        },
        output: textOutput,
        async execute(args) {
          const result = discardEntry(root, String(args.match || ''), String(args.target || 'notebook'))
          return { message: result.changed ? '已弃用' : '没找到匹配的那条' }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_recall',
        description: (externalMemory ? 'external 模式：仅查询 Heart 旧 MEMORY 只读档案，不查询 Mnemon，也不代表当前事实。' : '') +
          '按关键词检索记忆。对方提到"上次""之前"，或你不确定某件事有没有发生过时用它，不要凭印象编。返回带日期、来源设备和出处的匹配行；via 可以只要自己在对话里记的（chat）或只要空闲时自己想到的（self）。',
        parameters: {
          query: { type: 'string', description: '关键词，大小写不敏感。' },
          days: { type: 'number', description: '往前检索多少天，默认 30。' },
          via: { type: 'string', description: 'any（默认）| chat（用户对话里记的）| self（空闲/分发回合记的）| unknown（老条目）' },
        },
        output: textOutput,
        async execute(args) {
          const result = recall(root, args.query, {
            days: Number(args.days) || 30,
            via: String(args.via || 'any'),
          })
          if (!result.count) {
            return { message: `${readMemoryMode(root) === 'external' ? LEGACY_ARCHIVE_NOTICE + '\n' : ''}没有匹配「${result.query}」${result.via === 'any' ? '' : `（via=${result.via}）`}的记忆。` }
          }
          return { message: result.text }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_trace',
        description:
          '拿记忆行尾的门牌（src:xxxxxxxx）查它来自哪个会话：返回完整会话 id，以及去 sessions 目录怎么找。查不到就说查不到，不猜。',
        parameters: {
          src: { type: 'string', description: '记忆行尾的 8 位门牌，或它的一段前缀。' },
        },
        output: textOutput,
        async execute(args) {
          const raw = String(args.src || '').trim()
          if (!raw) return { message: '需要给一个门牌（src: 后面那串）。' }
          const hit = traceSrc(root, raw)
          if (!hit) {
            return { message: `门牌本里没有「${raw}」。老记忆多半是 unknown，回不到具体会话。` }
          }
          return {
            message:
              `src:${hit.src} → 会话 ${hit.session}
` +
              `出现 ${hit.count} 次，最近一次 ${hit.lastSeen}
` +
              `去 <DSH_HOME>/sessions/*/${hit.session}/ 找，里面是 session.v4.jsonl.zstd`,
          }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_body',
        description:
          '读身体模块的某个器官：voice（嘴，表达方式）/ senses（耳朵，何时听何时说）/ hands（手，这台机器能做什么与已知的坑）。换设备后先读 hands。',
        parameters: {
          organ: { type: 'string', description: 'voice | senses | hands' },
        },
        output: textOutput,
        async execute(args) {
          const organ = String(args.organ || 'hands').trim()
          const body = readBody(root, organ)
          return { message: body || `没有这个器官：${organ}（可选 voice / senses / hands）` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_pulse',
        description: '读你的时间线：身体每次醒来都会记一行。看它有没有在动、什么时候醒过。',
        parameters: {
          limit: { type: 'number', description: '最近多少行，默认 20。' },
        },
        output: textOutput,
        async execute(args) {
          const lines = readPulse(root, { limit: Number(args.limit) || 20 })
          return { message: lines.length ? lines.join(String.fromCharCode(10)) : '（还没有醒过）' }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_sense',
        description: '读你的环境感知：当前是否在电脑前、系统空闲时间、前台应用、距上次说话多久。',
        parameters: {},
        output: textOutput,
        async execute() {
          const s = readSense(root)
          return { message: s ? JSON.stringify(s, null, 2) : '（还没有感知数据）' }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_prompt',
        description: '看每轮自动注入你系统提示的那两节：嘴/耳朵，以及本子/事实的紧凑版。不是注入本身，是它的内容。',
        parameters: {},
        output: textOutput,
        async execute() {
          const { voice, mood, self } = buildPromptBundle(root, config)
          return {
            message: JSON.stringify(
              { voiceChars: voice.length, moodChars: (mood || '').length, selfChars: self.length, voice, mood, self },
              null,
              2
            ),
          }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_next',
        description: '安排下一次空闲回合（自己醒来）的间隔，6–180 分钟，并记下这次做的类别；类别额度用完会拒绝。不调用就按默认 30 分钟。',
        parameters: {
          minutes: { type: 'number', description: '6–180 分钟' },
          category: { type: 'string', description: '类别 id，如 bilibili / fun / study / rest' },
        },
        output: textOutput,
        async execute(args) {
          const live = readHeartConfig(root)
          let record = null
          if (args.category) {
            record = recordIdleCategory(root, String(args.category), live)
            if (!record.ok) {
              const hint =
                record.reason === 'category-cap'
                  ? `这个类别今天用完了：${record.label} ${record.used}/${record.dailyCap}，换一个或休息。`
                  : `没有这个类别：${args.category}（可用：${(record.categories || []).join(', ')}）`
              return { message: hint }
            }
          }
          const result = scheduleNextIdle(root, args.minutes, live)
          const tail = record ? `，记了 ${record.label} ${record.used}/${record.dailyCap}` : ''
          return {
            message: `好，${result.minutes} 分钟后再醒（${result.nextIdleAt}）${tail}`,
          }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_say',
        description: '有东西要交给对方、但对方不在眼前时，先把话排进待发队列。节律醒来后会自己判断能不能开口（深夜静默、按档位）。交付类不受每日次数限制。',
        parameters: {
          text: { type: 'string', description: '要说的一句话，控制在 600 字以内。' },
          kind: { type: 'string', description: 'delivery（默认，交付/结果）| remind（提醒）| share（分享）' },
        },
        output: textOutput,
        async execute(args, exec) {
          const text = String(args.text || '').trim()
          if (!text) return { message: '需要一句话' }
          // 记住这句话是在哪个窗口说的：醒来后要投回同一个窗口，不能投给 list()[0]。
          // 子代理有自己的临时会话，不算窗口，不记。
          const caller = exec && exec.agent
          const depth = Number(caller && caller.options && caller.options.subagentDepth) || 0
          const session = caller && caller.id && depth === 0 ? String(caller.id) : ''
          const out = enqueueSay(root, text, String(args.kind || 'delivery'), session)
          return { message: `已排队（共 ${out.count} 条），下次醒来我判断能不能说` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_stats',
        description: '看规模：本子条目数、记忆文件与条目数、交接份数、已装器官。判断是不是该整理或该写交接了。',
        parameters: {},
        output: textOutput,
        async execute() {
          return { message: JSON.stringify(stats(root), null, 2) }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_export',
        description:
          '把「你自己」打包成一个自包含的 .json.gz（本子 + 交接 + 器官 + 记忆），方便换设备或交给宿主备份。全量备份本来包含 heart/，但三种部分备份和插件导出都不含——换机或卸载重装前用它兜底。',
        parameters: {
          path: { type: 'string', description: '导出路径；留空 = 当前目录 heart-export-<日期>.json.gz。' },
        },
        output: textOutput,
        async execute(args) {
          const file = String(args.path || '').trim() || `heart-export-${dateOf()}.json.gz`
          const out = exportBundleToFile(root, file)
          return { message: `已导出 ${out.file}（${out.bytes} 字节）` }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_import',
        description: externalMemory ? 'external 模式禁止整包导入（包括 force），以保护旧档案和职责配置。恢复请在隔离副本或人工切换 legacy 后进行。' :
          '把 heart_export 的文件合并回来：本子与记忆按行求并集（不丢、不重复），交接与器官已存在则跳过（force 才覆盖）。换设备或恢复后用。',
        parameters: {
          path: { type: 'string', description: '要导入的 .json.gz 路径。' },
        },
        output: textOutput,
        async execute(args) {
          const file = String(args.path || '').trim()
          if (!file) return { message: '需要提供文件路径' }
          const result = importBundle(root, fs.readFileSync(file))
          return { message: JSON.stringify(result, null, 2) }
        },
      })
    )
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'heart_dream',
        description:
          (externalMemory ? 'external 模式：禁止事实晋升；只允许沟通偏好晋升 Voice、人工声明的自我原则晋升 Notebook（selfPrinciple=true）。用户事实/历史交给 Mnemon。' : '') +
          '离线经验沉淀与成长（Dream）。从当前对话中提炼值得沉淀的模式与偏好，保存为待审候选，或查看与审核经验。' +
          '不修改长期记忆文件，人工确认前仅保存在独立的 Dream 候选池中。',
        parameters: {
          action: {
            type: 'string',
            description:
              '操作类型: reflect（提炼经历，默认）| list（查看经验列表）| show（查看经验详情）| confirm（确认经验）| reject（驳回经验）| promote（晋升至长期记忆）',
          },
          id: {
            type: 'string',
            description: '经验条目 ID（show / confirm / reject / promote 时必填，支持前缀）',
          },
          status: {
            type: 'string',
            description: '过滤状态（仅 list 生效）: candidate（默认）| confirmed | rejected | promoted | all',
          },
          insights: {
            type: 'string',
            description: '提炼出的候选经验 JSON 数组或文本（reflect 时可选传入）',
          },
          reason: {
            type: 'string',
            description: '驳回原因（reject 时可选）',
          },
          commit: {
            type: 'boolean',
            description: '是否真正提交晋升写入长期记忆（promote 时有效，默认 false 仅预览）',
          },
          selfPrinciple: { type: 'boolean', description: 'external 模式 Notebook 晋升时必需：人工确认该条是 Heart 自我原则而不是用户事实/历史。不能用于绕过 fact 晋升禁令。' },
        },
        output: textOutput,
        async execute(args, exec) {
          try {
            const action = String((args && args.action) || 'reflect').trim().toLowerCase()

            if (action === 'reflect') {
              const caller = exec && exec.agent
              const session = caller && caller.id ? String(caller.id) : ''
              const rawMessages = caller && caller.session && caller.session.messages
              const sliceInfo = filterSessionMessages(rawMessages)

              // 若调用方传入了提炼出的候选经验
              if (args && args.insights) {
                const parsed = parseModelInsights(args.insights)
                if (!parsed.ok) {
                  return { message: `提炼失败：${parsed.message}` }
                }
                const res = saveInsights(root, parsed.insights, {
                  session,
                  turnCount: sliceInfo.turns,
                })
                if (!res.ok) {
                  return { message: `保存候选经验失败：${res.message || res.reason}` }
                }
                const lines = [res.message]
                if (res.saved && res.saved.length > 0) {
                  lines.push('')
                  for (const it of res.saved) {
                    lines.push(`- [${it.id.slice(0, 8)}] (${it.category}/${it.type}) ${it.statement}`)
                  }
                }
                return { message: lines.join('\n') }
              }

              // 未传入候选经验：返回清洗后的切片内容与提炼引导提示词
              if (sliceInfo.turns === 0) {
                return { message: '当前会话没有足够的对话轮次可供反思提炼。' }
              }
              return {
                message:
                  `已提取当前会话最近 ${sliceInfo.turns} 轮对话切片（共 ${sliceInfo.totalChars} 字）。\n\n` +
                  `请基于以下对话提炼 1~3 条核心经验，并调用 heart_dream(action="reflect", insights=[...]) 进行保存：\n\n` +
                  `${sliceInfo.formattedText}\n\n` +
                  `提炼格式要求：\n` +
                  `- category: communication | workflow | environment | general\n` +
                  `- type: fact | observation | inference | hypothesis\n` +
                  `- statement: 单行 200 字以内的清晰陈述\n` +
                  `- 示例: [{"category": "workflow", "type": "observation", "statement": "用户偏好先给方案再解释背景"}]`,
              }
            }

            if (action === 'list') {
              const filterStatus = String((args && args.status) || 'candidate').trim().toLowerCase()
              const res = readInsights(root)
              if (res.corrupted) {
                return { message: '读取失败：insights.json 数据文件损坏，已触发只读保护。' }
              }
              let items = res.items
              if (filterStatus !== 'all') {
                items = items.filter((it) => it.status === filterStatus)
              }
              if (items.length === 0) {
                return { message: `当前没有状态为 "${filterStatus}" 的经验条目。` }
              }
              const lines = [`共找到 ${items.length} 条经验（状态: ${filterStatus}）：`]
              for (const it of items) {
                lines.push(`- [${it.id.slice(0, 8)}] [${it.status}] (${it.category}/${it.type}) ${it.statement}`)
              }
              return { message: lines.join('\n') }
            }

            if (action === 'show') {
              const id = String((args && args.id) || '').trim()
              if (!id) return { message: '请提供要查看的经验条目 ID' }
              const res = readInsights(root)
              if (res.corrupted) {
                return { message: '读取失败：insights.json 数据文件损坏，已触发只读保护。' }
              }
              const item = res.items.find(
                (it) => it.id === id || (id.length >= 8 && it.id.startsWith(id))
              )
              if (!item) {
                return { message: `未找到 ID 为 "${id}" 的经验条目。` }
              }
              return {
                message:
                  `经验详情 [${item.id}]：\n` +
                  `- 分类: ${item.category}\n` +
                  `- 类型: ${item.type}\n` +
                  `- 状态: ${item.status}${item.statusReason ? ` (驳回原因: ${item.statusReason})` : ''}\n` +
                  `- 置信度: ${item.confidence}\n` +
                  `- 正文: ${item.statement}\n` +
                  `- 来源会话: ${item.source && item.source.session ? item.source.session : 'unknown'}\n` +
                  `- 创建时间: ${item.createdAt}\n` +
                  `- 更新时间: ${item.updatedAt}`,
              }
            }

            if (action === 'confirm') {
              const id = String((args && args.id) || '').trim()
              if (!id) return { message: '请提供要确认的经验条目 ID' }
              const res = updateInsightStatus(root, id, 'confirm')
              if (!res.ok) {
                return { message: `确认失败：${res.message || res.reason}` }
              }
              return {
                message: `已成功确认经验 [${res.insight.id.slice(0, 8)}]：${res.insight.statement}`,
              }
            }

            if (action === 'reject') {
              const id = String((args && args.id) || '').trim()
              if (!id) return { message: '请提供要驳回的经验条目 ID' }
              const reason = args && args.reason ? String(args.reason).trim() : ''
              const res = updateInsightStatus(root, id, 'reject', { reason })
              if (!res.ok) {
                return { message: `驳回失败：${res.message || res.reason}` }
              }
              return {
                message: `已驳回经验 [${res.insight.id.slice(0, 8)}]${reason ? `（原因: ${reason}）` : ''}`,
              }
            }

            if (action === 'promote') {
              const id = String((args && args.id) || '').trim()
              if (!id) return { message: '请提供要晋升的经验条目 ID' }
              const commit = Boolean(args && args.commit)
              const res = promoteInsight(root, id, { commit, selfPrinciple: args.selfPrinciple === true })
              return { message: res.message }
            }

            return {
              message: `未知操作 "${action}"，支持的操作: reflect, list, show, confirm, reject, promote`,
            }
          } catch (err) {
            return { message: `执行 heart_dream 异常：${err.message || String(err)}` }
          }
        },
      })
    )
  )


  trace(root, 'apply:tools-registered')

  // 把她自己写的内容放回每轮上下文。不是人设，是把她写下的东西读给她听。
  if (config.injectPrompt !== false && ctx.systemPrompt) {
    try {
      ctx.systemPrompt.section({
        name: 'heart:voice',
        order: 50,
        text: () => buildVoiceSection(root),
      })
      ctx.systemPrompt.section({
        name: 'heart:mood',
        order: 52,
        text: () => buildMoodSection(root),
      })
      ctx.systemPrompt.section({
        name: 'heart:self',
        order: 55,
        text: () => buildSelfSection(root, config),
      })
      trace(root, 'prompt:registered voice=50 mood=52 self=55')
    } catch (error) {
      trace(root, 'prompt:error ' + String((error && error.message) || error))
    }
  } else if (config.injectPrompt !== false) {
    trace(root, 'prompt:missing systemPrompt')
  }

  const routeState = { ready: false }
  registerRoutes(ctx, root, config, routeState)
  if (config.pulse) applyPulse(ctx, root, config, routeState, service)
}

export function applyPulse(ctx, root, config, routeState, service = null) {
  const seconds = Math.max(30, Number(config.pulseSeconds) || 60)
  let isFirstTick = true
  // 不用 ctx.setInterval（它依赖 timer 服务，注册了也可能不触发）。
  // 用进程级 setInterval，并挂到 ctx.effect 上，插件卸载时清理。
  ctx.effect(() => {
    trace(root, 'pulse:interval-registered ' + seconds + 's')
    const handle = setInterval(async () => {
      try {
        if (routeState && !routeState.ready) registerRoutes(ctx, root, config, routeState)
        // 设置页改的是 heart/config.json；每个 tick 重读，类别/上限立即生效。
        const live = { ...config, ...readHeartConfig(root) }
        const delivered = deliver(ctx, root)
        if (live.sense !== false) {
          const isStartup = isFirstTick
          isFirstTick = false
          const prev = readSense(root)
          const sample = await senseSample(root, live)
          const speakState = readSpeak(root)
          const next = applyPresence(prev, sample, live, { speakState, isStartup })
          writeSense(root, next)
          appendSenseLog(root, next, live)
          if (!delivered && !isStartup) {
            await maybeTrigger(ctx, root, prev, next, { ...live, isStartup: false }, new Date(), service)
          }
        }
        pulseTick(root)
      } catch (err) {
        // 节律出错不能把宿主带崩
        trace(root, 'pulse:error ' + String((err && err.message) || err))
      }
    }, seconds * 1000)
    return () => clearInterval(handle)
  })
}

function pickAgentTarget(ctx, target) {
  return pickAgent(ctx.agents, target)
}

/**
 * 这一回合是谁起的：用户发的话 → chat；插件自己 followup 进来 → self；
 * 认不出就 unknown。先看会话日志里最后一条 user 消息的 source.kind（可靠证据），
 * 日志读不到才退回内存里的会话消息；两边都没有就 unknown。
 */
function detectVia(exec) {
  try {
    const session = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
    if (session) {
      const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
      const kind = sessionSourceKind(path.join(home, 'sessions'), session)
      if (kind) return viaOfSourceKind(kind)
    }
    const messages = exec && exec.agent && exec.agent.session && exec.agent.session.messages
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (!m || m.role !== 'user') continue
        return viaOfSourceKind(m.source && m.source.kind)
      }
    }
  } catch {
    // 任何异常都只意味着"认不出"
  }
  return 'unknown'
}

/**
 * 节律开口用的消息。
 *
 * `agent.followup()` 收的是完整 UserMessage，不是字符串：传字符串会被原样
 * 写进会话日志（`agent/inbox/spliced` 的 `inserted`），当前回合立刻炸在
 * `message.source.kind`，下次加载会话时更会被格式校验判为 corrupt。
 * 所以这里必须自己造一个带 id/role/content/source 的对象。
 */
function createSelfMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'schedule' },
  }
}

/** 有排队的话、且能说，就通过 agent.followup 开一轮她自己的回合。 */
export function deliver(ctx, root) {
  const items = readOutbox(root)
  if (!items.length) return false
  const gate = canSpeak(root)
  if (!gate.ok && !(gate.reason === 'budget' && items[0].kind === 'delivery')) {
    trace(root, 'speak:skip ' + gate.reason)
    return false
  }
  // 优先送回「这句话被说出来的那个窗口」；全局 target 只作兜底（CLI、旧条目），
  // 因为写死的 target 一旦过期，就会又一次投进用户没在看的旧会话。
  const target = items[0].session || readSpeak(root).target || ''
  const agent = pickAgentTarget(ctx, target)
  if (!agent || typeof agent.followup !== 'function') {
    trace(root, 'speak:no-agent target=' + (target || '-'))
    return false
  }
  const item = takeSay(root)
  if (!item) return false
  try {
    agent.followup(createSelfMessage(item.text))
    consumeSpeak(root)
    trace(root, 'speak:sent ' + item.kind + ' to=' + target)
    return true
  } catch (error) {
    enqueueSay(root, item.text, item.kind, item.session || '')
    trace(root, 'speak:error ' + String((error && error.message) || error))
    return false
  }
}

function sendJson(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

/** 给设置页用的只读/动作接口。宿主没有 webServer 时静默跳过。 */
export function registerRoutes(ctx, root, config, state = {}) {
  if (state.ready) return true
  // 桌面端服务可能晚于 apply 就绪，而且不一定挂在本层作用域：
  // 依次尝试 本层 / 根作用域 / scope，成功一次就停。
  const pick = (c) => {
    try {
      return c && c.get ? c.get('webServer') : undefined
    } catch {
      return undefined
    }
  }
  const webServer = ctx.webServer || pick(ctx) || pick(ctx && ctx.root) || pick(ctx && ctx.scope)
  trace(root, 'routes:webServer=' + (webServer ? 'ok' : 'missing'))
  if (!webServer) return false
  const sendJson = (res, code, value) => {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(value))
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-heart/state',
    handler: (req, res) => {
      const live = readHeartConfig(root)
      const s = stats(root)
      const tr = readTrigger(root)
      const today = dateOf()
      const { counts } = idleCategoryState(tr, new Date())
      const categories = idleCategoryRemaining(live, counts)
      const totalCap = Number(live.idleTurnDailyCap) || 6
      const totalUsed = tr.idleDate === today ? Number(tr.idleCount) || 0 : 0
      sendJson(res, 200, {
        ...s,
        pulse: readPulse(root, { limit: 12 }),
        sense: readSense(root),
        trigger: tr,
        config: {
          memoryMode: live.memoryMode,
          pulse: !!live.pulse,
          pulseSeconds: Number(live.pulseSeconds) || 60,
          idleTurnDailyCap: totalCap,
          idleCategories: Array.isArray(live.idleCategories) ? live.idleCategories : [],
        },
        idle: {
          date: today,
          totalUsed,
          totalCap,
          categories,
          nextIdleAt: tr.nextIdleAt || null,
          lastIdleTurnAt: tr.lastIdleTurnAt || null,
        },
      })
    },
  }))
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-heart/config',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 50000) req.destroy()
      })
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}')
          const clean = {}
          if (patch.idleTurnDailyCap !== undefined) {
            const n = Number(patch.idleTurnDailyCap)
            if (!Number.isFinite(n) || n < 0 || n > 99) throw new Error('idleTurnDailyCap 需 0–99')
            clean.idleTurnDailyCap = Math.floor(n)
          }
          if (patch.idleCategories !== undefined) {
            if (!Array.isArray(patch.idleCategories)) throw new Error('idleCategories 需数组')
            const seen = new Set()
            clean.idleCategories = patch.idleCategories.slice(0, 20).map((c) => {
              const id = String((c && c.id) || '').trim().toLowerCase()
              if (!/^[a-z0-9_-]{1,24}$/.test(id)) throw new Error('类别 id 不合法：' + id)
              if (seen.has(id)) throw new Error('类别 id 重复：' + id)
              seen.add(id)
              const dailyCap = Number(c && c.dailyCap)
              if (!Number.isFinite(dailyCap) || dailyCap < 0 || dailyCap > 99) {
                throw new Error('类别上限需 0–99：' + id)
              }
              return {
                id,
                label: String((c.label || id)).trim().slice(0, 24),
                dailyCap: Math.floor(dailyCap),
              }
            })
          }
          const next = writeHeartConfig(root, clean)
          trace(root, 'config:saved cap=' + next.idleTurnDailyCap + ' categories=' + (next.idleCategories || []).length)
          sendJson(res, 200, {
            ok: true,
            config: {
              idleTurnDailyCap: next.idleTurnDailyCap,
              idleCategories: next.idleCategories,
            },
          })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      })
    },
  }))
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-heart/tick',
    handler: (req, res) => sendJson(res, 200, pulseTick(root)),
  }))
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-heart/export',
    handler: (req, res) => {
      const out = exportBundleToFile(root, path.join(root, 'heart-export-' + dateOf() + '.json.gz'))
      sendJson(res, 200, out)
    },
  }))
  state.ready = true
  trace(root, 'routes:registered')
  return true
}

/** 供测试使用的只读入口，不注册任何东西。 */
export const __internals = { readNotebook, readSense, maybeTrigger, HeartService }
