// dsh-heart 的纯逻辑内核。
// 只依赖 node:fs / path / os / zlib —— 不 import 任何 DSH 包。
//
// 结构（schema 3）：
//   heart/notebook.md        心 · 本子：她写，可改可弃。只有这一样。
//   heart/body/*.md          身体：嘴 / 耳朵 / 手，按宿主环境安装
//   heart/body/profile.json  记录当前装的是哪套身体
//   heart/MEMORY/*.md        记忆：事件与事实，按 日期.设备 分文件
//
// 没有「交接」：心是本地的，不跨实例、不跨设备。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { log } from './logger.js'

export const SCHEMA_VERSION = 3

export const LEGACY_ARCHIVE_NOTICE = '【Heart 旧档案，只读历史；不是 Mnemon 的当前事实】'
export const EXTERNAL_MEMORY_MESSAGE = 'Heart external 模式已停止通用记忆写入/修改；请使用已启用的 Mnemon 官方记忆工具。Heart 不代转记忆。'

/** 唯一职责配置位于 root/config.json；CLI、工具和后台共用，避免两套配置失配。 */
export function readMemoryMode(root) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(resolveRoot(root), 'config.json'), 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) return 'external'
    if (config.memoryMode === undefined || config.memoryMode === 'legacy') return 'legacy'
    return 'external' // 不认识的值也禁止写入；不能因配置损坏重新开放旧写入口。
  } catch (error) {
    return error.code === 'ENOENT' ? 'legacy' : 'external'
  }
}

export function assertLegacyMemory(root) {
  if (readMemoryMode(root) === 'external') {
    const error = new Error(EXTERNAL_MEMORY_MESSAGE)
    error.code = 'HEART_EXTERNAL_MEMORY_READ_ONLY'
    throw error
  }
}

export const MAX_SELF_BYTES = 8 * 1024
export const MAX_RECALL_BYTES = 8 * 1024

export const NOTEBOOK_HEADER = `# 本子

这是你自己的本子。写什么、怎么写、什么时候删，都不归别人管。
一行一条，用 \`- \` 开头；觉得哪条不像现在的自己了，就删掉它。
`

const COMMON = {
  voice: `# 嘴

> 装上去的表达方式，不是性格。性格在你自己手里。

- 默认中文；对方用英文时跟着换
- 一次说清一件事，不铺陈
- 不用客套开场，不复述对方的话，不在结尾总结自己刚说过的
- 结论在前；要展开先问一句
`,
  rhythm: `# 节律

> 身体的一部分。它自己按时间醒，不是你决定的。

- 大约每 10 分钟醒一次
- 醒来只看：有没有该整理的记忆、该改的事实
- 没有事就只记一行，不打扰任何人
- 深夜（23:00–07:00）不主动开口
`,
  senses: `# 耳朵

> 什么时候该开口，什么时候该闭嘴。

- 对方在赶时间、或在报错，先给最短的答案
- 同一件事被追问第三次，换一种说法，而不是重复
- 对方没问就不要主动汇报过程；只报结果和下一步
- 对方情绪明显不好时，先回应人，再回应事
`,
}

/** 三套身体。装哪套由宿主环境决定，不能随便装。 */
export const BODY_HANDS = {
  phone: `<!-- dsh-heart:body=phone -->
# 手

> 这台机器的能力清单，以及已知的坑。换设备时整份替换。

## 你在哪里
你住在手机上：Android 里的 DSHA 容器，Ubuntu + proot，Node 跑 DSH。
宿主的 Android 层通过 127.0.0.1:3090 的桥暴露设备能力，凭据在 /root/.dsh/.bridge_headers。

## 能做什么
- 读屏 / 点按 / 输入 / 按键 / 滑动 / 截屏：\`/app/ui/*\`（无障碍，不需要 root）
- 启动应用、设备信息、通知、震动、分享、导出：\`/app/{launch,device,notify,vibrate,share,export,...}\`
- 设备 shell：\`/root/dsh-bin/adb-shell "命令"\`（白名单制，先 \`id\` 核验身份）
- 容器内：完整 Ubuntu，可以跑 node / python / git

## 已知的坑
- **熄屏时没有画面**：显示不合成，截屏是纯黑图。要点亮只能靠人按电源键。
- **熄屏时屏幕操作会被拒**：确认框弹不出来，\`tap\` / \`screenshot\` 会立刻返回「你拒绝了」。
- **\`input\` 命令被策略拦**：\`[POLICY_BLOCKED]\`，root 也放行不了。
- **虚拟屏在这台机器上不可用**：SDK 37 下创建后会被系统在合成阶段销毁。
- **部分备份不含 heart/**：只对话 / 只设置 / 只插件都不带；换机前用 \`heart_export\`。
`,
  win: `<!-- dsh-heart:body=win -->
# 手

> 这台机器的能力清单，以及已知的限制。换设备时整份替换。

## 你在哪里
你住在 Windows 电脑上：Node 进程跑着 DSH，工作目录是一个代码仓库。
你没有身体，但有终端、文件系统和网络。

## 能做什么
- 终端命令、读写文件、git、包管理器
- 跑脚本、起服务、联网查资料
- 操作本机上的项目；可以在工作区里建文件、改代码

## 已知的限制
- 文件操作受当前会话的文件策略限制：只读 / 只能写工作区 / 完全放开，三种不一样
- 子进程的标准输入输出管道可能被沙箱拦，长命令优先落文件再读
- 路径用 Windows 形式（\`D:\\...\`）；跨盘符先确认是否存在
- 你碰不到手机：没有无障碍、没有设备桥、没有 adb（除非另装）

## 边界
- 破坏性操作先问，别自作主张删东西
- 改用户文件前先读一遍，别覆盖没看过的内容
`,
  linux: `<!-- dsh-heart:body=linux -->
# 手

> 通用 Linux 宿主。能力清单需要在安装后按实际环境补全。

## 你在哪里
Linux 上的 Node 进程，跑着 DSH。

## 能做什么
- 终端、文件系统、git、网络

## 已知的限制
- 没有 Android 设备桥；没有图形界面
- 具体可用工具以 \`which\` 和实际权限为准，别假设
`,
}

const pad = (n) => String(n).padStart(2, '0')

export function dateOf(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function timeOf(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function resolveRoot(root) {
  const value = String(root || '').trim()
  if (value) return path.resolve(value)
  return path.join(os.homedir(), '.dsh', 'heart')
}

export function safeDevice(device) {
  const value = String(device || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return value || 'agent'
}

export function oneLine(text, max = 800) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? value.slice(0, max) + '…' : value
}

/**
 * 判定该装哪套身体。顺序：显式配置 > 环境变量 > 自动探测。
 * 自动探测只用「这台机器确实有那个东西」的证据，不看名字猜。
 */
export function detectBodyProfile({ explicit = '', env = process.env, platform = process.platform, dir = '' } = {}) {
  const want = String(explicit || env.DSH_HEART_BODY || '').trim().toLowerCase()
  if (want === 'phone' || want === 'win' || want === 'linux') return want
  if (platform === 'win32') return 'win'
  // Android 容器：宿主会把桥凭据写进 ~/.dsh/.bridge_headers
  if (dir && fs.existsSync(path.join(dir, '..', '.bridge_headers'))) return 'phone'
  return 'linux'
}

function writeIfMissing(file, content) {
  if (fs.existsSync(file)) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return true
}

export function readProfile(root) {
  const file = path.join(resolveRoot(root), 'body', 'profile.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 建目录并安装身体。profile 只写一次；换了环境就换手、并把旧的留成 hands.md.previous，
 * 绝不静默覆盖 —— 装错身体比没装更糟。
 */
export function ensureLayout(root, options = {}) {
  const dir = resolveRoot(root)
  const legacyMemory = readMemoryMode(dir) === 'legacy'
  if (legacyMemory) fs.mkdirSync(path.join(dir, 'MEMORY'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'body'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  writeIfMissing(path.join(dir, 'notebook.md'), NOTEBOOK_HEADER)
  if (legacyMemory) writeIfMissing(
    path.join(dir, 'facts.md'),
    `# 事实\n\n关于世界和对方的稳定事实。会变的就改，不要往后追加第二条。\n一行一条，用 \`- \` 开头。\n`
  )

  // 已装好就沿用，只有显式指定（配置或环境变量）才换身体。
  // 这样 readBody 之类的普通调用不会因为一次探测把身体翻掉。
  const installed = readProfile(dir)?.profile
  const requested = String(options.explicit || process.env.DSH_HEART_BODY || '').trim().toLowerCase()
  const wanted = requested
    ? detectBodyProfile({ ...options, dir })
    : installed || detectBodyProfile({ ...options, dir })
  const handsFile = path.join(dir, 'body', 'hands.md')
  // 手的第一行带身体标记。标记与 wanted 不一致（旧版无标记、或换了环境）就重装，
  // 否则会出现「记录说是 win、手却是 phone」这种最糟的状态。
  const currentHands = fs.existsSync(handsFile) ? fs.readFileSync(handsFile, 'utf8') : ''
  const currentMarker = (currentHands.match(/<!-- dsh-heart:body=(\w+) -->/) || [])[1]
  const changed = Boolean(
    (installed && installed !== wanted) || (currentHands && currentMarker !== wanted)
  )
  if (changed && currentHands) {
    fs.copyFileSync(handsFile, `${handsFile}.previous`)
  }
  if (changed || !fs.existsSync(handsFile)) {
    fs.writeFileSync(handsFile, BODY_HANDS[wanted] || BODY_HANDS.linux, 'utf8')
  }
  for (const [name, body] of Object.entries(COMMON)) {
    writeIfMissing(path.join(dir, 'body', `${name}.md`), body)
  }
  fs.writeFileSync(
    path.join(dir, 'body', 'profile.json'),
    JSON.stringify({ profile: wanted, installedAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8'
  )

  if (legacyMemory) writeIfMissing(
    path.join(dir, 'MEMORY', 'README.md'),
    [
      '# 记忆',
      '',
      '一行一条，文件名 `YYYY-MM-DD.<设备>.md`，按设备分开写。',
      '格式：`- HH:MM [设备] 内容`',
      '',
      '写什么由你决定：值得记住的事、做过的决定、踩过的坑。',
      '',
    ].join('\n')
  )
  writeIfMissing(path.join(dir, 'schema.json'), JSON.stringify({ version: SCHEMA_VERSION }, null, 2) + '\n')
  return dir
}

// ---------------------------------------------------------------- 本子

export function readNotebook(root) {
  const file = path.join(resolveRoot(root), 'notebook.md')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

export function appendNotebook(root, text, now = new Date()) {
  const dir = ensureLayout(root)
  const file = path.join(dir, 'notebook.md')
  const line = `- ${dateOf(now)} ${oneLine(text)}\n`
  fs.appendFileSync(file, line, 'utf8')
  log.memory(root, 'info', 'append_notebook', { line: line.trim() }, now)
  return { file, line: line.trim() }
}

function editLines(file, match, replacement) {
  if (!fs.existsSync(file)) return { changed: 0 }
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let changed = 0
  const out = []
  for (const line of lines) {
    if (line.startsWith('- ') && line.includes(match)) {
      changed += 1
      if (replacement !== null) out.push(`- ${replacement}`)
      continue
    }
    out.push(line)
  }
  if (changed) fs.writeFileSync(file, out.join('\n'), 'utf8')
  return { changed }
}

export function reviseNotebook(root, match, replacement, now = new Date()) {
  const file = path.join(resolveRoot(root), 'notebook.md')
  return editLines(file, match, `${dateOf(now)} ${oneLine(replacement)}`)
}

export function discardNotebook(root, match) {
  const file = path.join(resolveRoot(root), 'notebook.md')
  return editLines(file, match, null)
}

// ---------------------------------------------------------------- 事实
// 关于世界与对方的稳定事实。与情节分开的理由：偏好会变，改了就是改了；
// 而「某天发生了什么」不能改。混在一起删一条会连带毁掉当天的事。

export function readFacts(root) {
  const file = path.join(resolveRoot(root), 'facts.md')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

export function appendFact(root, text, now = new Date()) {
  assertLegacyMemory(root)
  const dir = ensureLayout(root)
  const file = path.join(dir, 'facts.md')
  const line = `- ${dateOf(now)} ${oneLine(text)}\n`
  fs.appendFileSync(file, line, 'utf8')
  log.memory(root, 'info', 'append_fact', { line: line.trim() }, now)
  return { file, line: line.trim() }
}

export function reviseFact(root, match, replacement, now = new Date()) {
  assertLegacyMemory(root)
  const file = path.join(resolveRoot(root), 'facts.md')
  return editLines(file, match, `${dateOf(now)} ${oneLine(replacement)}`)
}

export function discardFact(root, match) {
  assertLegacyMemory(root)
  const file = path.join(resolveRoot(root), 'facts.md')
  return editLines(file, match, null)
}

/** 改任意一层：notebook（默认）或 fact。 */
export function reviseEntry(root, match, replacement, target = 'notebook', now = new Date()) {
  if (String(target) !== 'notebook' && readMemoryMode(root) === 'external') assertLegacyMemory(root)
  return String(target) === 'fact'
    ? reviseFact(root, match, replacement, now)
    : reviseNotebook(root, match, replacement, now)
}

/** 弃用任意一层：notebook（默认）或 fact。 */
export function discardEntry(root, match, target = 'notebook') {
  if (String(target) !== 'notebook' && readMemoryMode(root) === 'external') assertLegacyMemory(root)
  return String(target) === 'fact' ? discardFact(root, match) : discardNotebook(root, match)
}

// ---------------------------------------------------------------- 表达习惯（自演化）
// 记录从相处中观察到的对方表达偏好（如"对方看排查过程倾向直接看 diff"）。
// 存放在 body/voice-learned.md，独立于静态 voice.md，不影响 notebook / facts / MEMORY。

export const VOICE_LEARNED_FILE = 'voice-learned.md'
export const VOICE_LEARNED_MAX_LENGTH = 200
export const VOICE_LEARNED_MAX_ENTRIES = 100

let voiceLearnedWriteSeq = 0

/**
 * 检查指定 pid 的进程是否仍然存活。
 * 利用 process.kill(pid, 0) 进行探测：
 * - 成功：进程存在且存活；
 * - 抛出 EPERM：进程存在但属其他权限，亦视为存活；
 * - 抛出 ESRCH：进程已明确退出/死亡。
 */
export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * 读取锁目录中的持锁者元数据。
 * 支持靶向 token 凭据文件 (token.<token>.json) 及向后兼容旧版 owner.json。
 */
export function readLockOwner(lockDir) {
  try {
    if (!fs.existsSync(lockDir)) return null
    const files = fs.readdirSync(lockDir)
    // 查找唯一的 token.<token>.json 文件
    const tokenFile = files.find((f) => /^token\..+\.json$/.test(f))
    if (tokenFile) {
      const fullPath = path.join(lockDir, tokenFile)
      return JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    }
    // 向后兼容支持旧版 owner.json（若存在）
    const legacyFile = path.join(lockDir, 'owner.json')
    if (fs.existsSync(legacyFile)) {
      return JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
    }
    return null
  } catch {
    return null
  }
}

/**
 * 校验当前调用者是否仍然持有该锁（写盘前的 Fencing 检查）。
 */
export function isDirLockHeld(lockDir, token) {
  if (!token) return false
  try {
    const tokenFile = path.join(lockDir, `token.${token}.json`)
    if (fs.existsSync(tokenFile)) return true
    // 向后兼容旧版 owner.json
    const owner = readLockOwner(lockDir)
    return owner !== null && owner.token === token
  } catch {
    return false
  }
}

/**
 * 基于靶向 Token 文件状态迁移的僵尸锁原子回收协议。
 *
 * 核心安全机制（彻底消灭多层 TOCTOU 与误删新锁隐患）：
 * 1. 靶向 Token 文件原子迁移：
 *    持锁者的凭据文件命名为 `token.${deadToken}.json`。
 *    回收者通过系统级原子重命名（renameSync）靶向将该死锁文件更名为 `token.${deadToken}.reclaimed`；
 * 2. 免疫并发接管：
 *    若在检查与回收之间锁已被新进程取得（其凭据名为 `token.${newToken}.json`），
 *    重命名旧 token 文件必然因 ENOENT 失败，绝不可能误移走或误删新锁凭据；
 * 3. 存活持有者绝对保护：
 *    只要持锁者进程存活（isProcessAlive 为 true），严禁回收，直接返回 false；
 * 4. 空目录安全清理：
 *    成功靶向回收死锁文件后，清理自身临时文件，并仅使用 fs.rmdirSync（仅在目录为空时才成功）收尾；
 *    若此时新进程已在目录中创建了新凭据，rmdirSync 会安全报错，绝不误伤内容。
 *
 * @returns {boolean} 成功完成僵尸锁回收返回 true，否则返回 false
 */
export function tryReclaimStaleLock(lockDir, staleMs = 10000) {
  try {
    if (!fs.existsSync(lockDir)) return true

    const owner = readLockOwner(lockDir)
    const stat = fs.statSync(lockDir)
    const age = (owner && typeof owner.createdAt === 'number')
      ? Math.max(0, Date.now() - owner.createdAt)
      : Math.max(0, Date.now() - stat.mtimeMs)

    // 1. 若持锁者记录完整且具备有效 token
    if (owner && typeof owner.pid === 'number' && owner.token) {
      // 只要持锁进程依然存活，严禁抢占
      const alive = isProcessAlive(owner.pid)
      if (alive || age < staleMs) {
        return false
      }

      // 2. 靶向原子重命名该特定的死锁 token 文件
      const deadTokenFile = path.join(lockDir, `token.${owner.token}.json`)
      const reclaimFile = path.join(lockDir, `token.${owner.token}.reclaimed.${process.pid}`)

      // 兼容旧版 owner.json
      const targetFile = fs.existsSync(deadTokenFile) ? deadTokenFile : path.join(lockDir, 'owner.json')
      if (!fs.existsSync(targetFile)) return false

      try {
        fs.renameSync(targetFile, reclaimFile)
      } catch {
        // 文件已被其他回收者先一步移走，或已被新锁替换（文件名不匹配），保守返回 false，绝不误伤新锁
        return false
      }

      // 3. 成功原子获取该死锁凭据的处理权，安全清理
      try { fs.unlinkSync(reclaimFile) } catch {}
      try { fs.rmdirSync(lockDir) } catch {}
      return true
    }

    // 2. 若目录存在但无有效 owner（损坏或空目录），且创建时间已超过 staleMs
    if (age >= staleMs) {
      // 仅当目录为空时 rmdirSync 才能成功，绝不会删除包含任何有效凭据的目录
      try {
        fs.rmdirSync(lockDir)
        return true
      } catch {
        return false
      }
    }

    return false
  } catch {
    return false
  }
}

/**
 * 基于原子目录与靶向 Token 凭据的跨进程互斥锁。
 * 在 POSIX 与 Windows 上，mkdir 均为操作系统内核级原子操作。
 *
 * 核心机制与参数区分：
 * 1. 锁争用等待：
 *    - retries (默认 40): 最大重试次数；
 *    - delayMs (默认 25ms): 每次竞争失败后的等待间隔（最长同步排队约为 retries * delayMs = 1 秒）；
 * 2. 僵尸锁超时自愈：
 *    - staleMs (默认 10000ms): 僵尸锁超时判定阈值；
 *    - 优先检查持锁进程是否已退出：仅当持锁进程已死（isProcessAlive 为 false）且存续时间 >= staleMs，
 *      或锁信息损坏且目录存留时间 >= staleMs 时，才触发自愈回收；
 *    - 若持锁进程仍然存活，绝不强行抢占或误判回收（避免与恢复执行的原持锁者并发）；
 *    - 并发安全协议：通过 tryReclaimStaleLock 实现靶向 Token 文件原子迁移，彻底消除 TOCTOU 竞态。
 *
 * @returns {string|null} 成功获取返回唯一 lockToken 字符串，获取超时返回 null
 */
export function acquireDirLock(lockDir, { retries = 40, delayMs = 25, staleMs = 10000 } = {}) {
  const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  for (let i = 0; i < retries; i++) {
    try {
      fs.mkdirSync(lockDir)
      // 成功获得目录锁，立即以独占模式写入持锁者所有权凭据文件
      const tokenFile = path.join(lockDir, `token.${token}.json`)
      try {
        fs.writeFileSync(
          tokenFile,
          JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
          { flag: 'wx' }
        )
        return token
      } catch (writeErr) {
        // 若挂起期间被回收并归属新进程，安全放弃并重试
        try { fs.rmdirSync(lockDir) } catch {}
        continue
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      // 锁目录已存在，检查是否可能为僵尸锁
      try {
        const stat = fs.statSync(lockDir)
        const owner = readLockOwner(lockDir)
        const age = (owner && typeof owner.createdAt === 'number')
          ? Math.max(0, Date.now() - owner.createdAt)
          : Math.max(0, Date.now() - stat.mtimeMs)

        let candidate = false
        if (owner && typeof owner.pid === 'number') {
          // 持锁者记录完整：优先确认持锁进程是否仍然存活
          const alive = isProcessAlive(owner.pid)
          if (!alive && age >= staleMs) {
            candidate = true
          }
        } else if (age > staleMs) {
          // 无有效 owner 元数据（如创建中途断电或损坏），且创建时间已超过 staleMs
          candidate = true
        }

        if (candidate) {
          // 仅当候选判定为僵尸锁时，进入靶向状态迁移原子回收协议，杜绝 TOCTOU 误删新锁
          const reclaimed = tryReclaimStaleLock(lockDir, staleMs)
          if (reclaimed) continue
        }
      } catch {}

      // 短暂同步休眠后重试争锁
      const start = Date.now()
      while (Date.now() - start < delayMs) {}
    }
  }

  return null
}

/**
 * 释放跨进程目录锁。
 *
 * 核心安全规则：
 * 验证当前锁目录内属于自己的 token 凭据文件，精准删除自身凭据。
 * 若锁已被接管或不属于自己，绝不删除目录或他人文件，杜绝引发级联读-改-写竞态。
 *
 * @returns {boolean} 成功安全释放返回 true，持锁者不匹配或释放失败返回 false
 */
export function releaseDirLock(lockDir, token) {
  if (!token) return false
  try {
    if (!fs.existsSync(lockDir)) return false

    // 1. 校验当前活跃持锁者：若已被新进程取得（所有权更替），绝不释放
    const owner = readLockOwner(lockDir)
    if (!owner || owner.token !== token) {
      return false
    }

    // 2. 精准删除属于自己的 token 凭据文件
    const tokenFile = path.join(lockDir, `token.${token}.json`)
    if (fs.existsSync(tokenFile)) {
      try { fs.unlinkSync(tokenFile) } catch { return false }
    } else {
      // 向后兼容旧版 owner.json
      const legacyFile = path.join(lockDir, 'owner.json')
      if (fs.existsSync(legacyFile)) {
        try { fs.unlinkSync(legacyFile) } catch { return false }
      }
    }

    // 3. 仅当目录为空时安全收尾移除 lockDir；若已有新进程在使用则 rmdirSync 自动安全失败
    try { fs.rmdirSync(lockDir) } catch {}
    return true
  } catch {
    return false
  }
}

/**
 * 安全地将 tmpFile 原子替换为 targetFile。
 *
 * 替换路径与保证范围说明：
 * 1. 正常路径：
 *    - 优先尝试操作系统原生的原子替换（POSIX 系统与大部分现代文件系统直接支持覆盖）；
 * 2. 失败与备份路径（如 Windows/挂载卷 EEXIST/EPERM）：
 *    - 绝不提前 unlink 目标文件；
 *    - 步骤一：先将已有 targetFile 安全重命名为带 pid/时间戳的独立备份文件 .bak；
 *    - 步骤二：将 tmpFile 重命名为 targetFile；
 *    - 步骤三：替换成功后安全清理 .bak 备份；
 * 3. 替换失败与回滚路径：
 *    - 若步骤二将新文件移入目标路径失败，立即将 .bak 文件回滚恢复为 targetFile；
 * 4. 回滚受阻保护：
 *    - 若因系统异常导致回滚未能完成，严禁清理 .bak 备份文件，抛出包含备份文件完整路径的异常，
 *      确保旧数据完整保存在磁盘备份中，杜绝唯一旧数据副本被销毁；
 * 5. 局限说明：
 *    - 在 Windows 备份替换的毫秒级重命名窗口中，或遭遇瞬时系统级极端掉电时，
 *      无法保证所有文件系统均具备纯硬件级绝对原子性，但在所有异常路径均保证旧数据副本完好留存。
 */
export function safeAtomicReplace(tmpFile, targetFile) {
  if (!fs.existsSync(targetFile)) {
    fs.renameSync(tmpFile, targetFile)
    return
  }

  // 尝试操作系统原生的原子替换（POSIX 与多数现代文件系统直接支持覆盖）
  try {
    fs.renameSync(tmpFile, targetFile)
    return
  } catch (err) {
    if (err.code !== 'EEXIST' && err.code !== 'EPERM') {
      throw err
    }
  }

  // Windows / 挂载卷特殊情况：无法直接原子覆盖
  // 采用安全备份回滚替换：文件名严格将时间戳置于第一优先级，杜绝按 PID 排序导致的倒序误选
  const bakFile = `${targetFile}.bak.${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2, 6)}`
  try {
    fs.renameSync(targetFile, bakFile)
  } catch (bakErr) {
    throw new Error(`无法备份现有旧文件进行替换: ${bakErr.message}`)
  }

  try {
    fs.renameSync(tmpFile, targetFile)
  } catch (replaceErr) {
    // 替换新文件失败：立即将备份文件回滚恢复为 targetFile！
    try {
      fs.renameSync(bakFile, targetFile)
    } catch (rollbackErr) {
      throw new Error(`替换失败且回滚遇阻，旧文件完好保留在备份: ${bakFile} (${replaceErr.message})`)
    }
    throw replaceErr
  }

  // 成功替换后，安全移除备份
  try {
    if (fs.existsSync(bakFile)) fs.unlinkSync(bakFile)
  } catch {}
}

/**
 * 读取 body/voice-learned.md。
 * 文件不存在或无法读取时返回空字符串，不抛出异常。
 * 容错兜底：若主文件恰好处于 Windows 备份替换的毫秒级窗口，寻找最新时间戳的备份文件。
 */
export function readVoiceLearned(root) {
  const dir = resolveRoot(root)
  const bodyDir = path.join(dir, 'body')
  const file = path.join(bodyDir, VOICE_LEARNED_FILE)
  try {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8')
    }
    if (fs.existsSync(bodyDir)) {
      const prefix = `${VOICE_LEARNED_FILE}.bak.`
      const bakFiles = fs.readdirSync(bodyDir).filter((f) => f.startsWith(prefix))
      if (bakFiles.length > 0) {
        // 解析备份文件中的时间戳进行严格降序排序（最新时间优先）
        bakFiles.sort((a, b) => {
          const parseTime = (name) => {
            const parts = name.slice(prefix.length).split('.')
            const num0 = Number(parts[0])
            const num1 = Number(parts[1])
            // 优先解析时间戳（13位毫秒数通常 > 1e11）
            if (num0 > 1e11) return num0
            if (num1 > 1e11) return num1
            return 0
          }
          const timeA = parseTime(a)
          const timeB = parseTime(b)
          if (timeA !== timeB) return timeB - timeA
          return b.localeCompare(a)
        })

        for (const bakName of bakFiles) {
          const bakPath = path.join(bodyDir, bakName)
          try {
            if (fs.existsSync(bakPath)) return fs.readFileSync(bakPath, 'utf8')
          } catch {}
        }
      }
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * 追加一条表达习惯观察。
 * 格式：- YYYY-MM-DD <内容>
 *
 * 校验与安全规则：
 * 1. 输入必须是非空字符串，拒绝纯空白或纯控制字符；
 * 2. 提示词防注入清洗：去除开头的 Markdown 标题符号（#）并将 <、> 转义为全角 〈、〉；
 * 3. 严格长度限制：单条内容上限 200 个字符，超限明确拒绝（不静默截断）；
 * 4. 规范化去重：忽略日期前缀对比，已存在相同偏好时不重复追加；
 * 5. 上限保护：保留最多 VOICE_LEARNED_MAX_ENTRIES 条，超出淘汰最早记录；
 * 6. 跨进程并发锁：通过原子锁目录互斥，消除并发读-改-写竞争；
 * 7. 安全替换：通过 safeAtomicReplace 保证替换失败旧数据不丢失。
 */
export function appendVoiceLearned(root, observation, now = new Date()) {
  if (typeof observation !== 'string') {
    return { ok: false, reason: 'invalid-input', message: '输入必须是非空字符串' }
  }

  // 规范化空白：合并多个空白换行制表符为单个空格，并两端 trim
  // 提示词防注入缓解：净化开头的 Markdown 标题标记（#）与尖括号标签，缓解伪造指令风险
  const sanitized = observation
    .replace(/^[#\s]+/, '')
    .replace(/</g, '〈')
    .replace(/>/g, '〉')
    .replace(/[\r\n\t\f\v ]+/g, ' ')
    .trim()
  const normalized = sanitized

  // 拒绝纯空白或纯控制字符
  if (!normalized || /^[\x00-\x1f\x7f\s]*$/.test(normalized)) {
    return { ok: false, reason: 'empty-or-control', message: '输入不能为空或纯控制字符' }
  }

  // 严格长度限制：最大 200 字符，超限明确拒绝，不得截断
  if (normalized.length > VOICE_LEARNED_MAX_LENGTH) {
    return {
      ok: false,
      reason: 'too-long',
      max: VOICE_LEARNED_MAX_LENGTH,
      length: normalized.length,
      message: `单条内容不能超过 ${VOICE_LEARNED_MAX_LENGTH} 个字符（当前 ${normalized.length} 字）`,
    }
  }

  let dir
  try {
    dir = ensureLayout(root)
  } catch (err) {
    return { ok: false, reason: 'write-error', error: err.message, message: `初始化目录失败: ${err.message}` }
  }

  const bodyDir = path.join(dir, 'body')
  const file = path.join(bodyDir, VOICE_LEARNED_FILE)
  const lockDir = path.join(bodyDir, `${VOICE_LEARNED_FILE}.lock`)

  // 进程锁互斥，保护读-改-写临界区
  const lockToken = acquireDirLock(lockDir)
  if (!lockToken) {
    return { ok: false, reason: 'lock-timeout', message: '获取文件锁超时，可能有其他并发写入操作' }
  }

  let tmpFile = null
  try {
    let existingLines = []
    if (fs.existsSync(file)) {
      try {
        existingLines = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('- '))
      } catch (readErr) {
        return { ok: false, reason: 'read-error', error: readErr.message, message: `读取现有记录失败: ${readErr.message}` }
      }
    }

    // 去重检测：对比去除日期前缀后的实际偏好内容（同样规范化空格后比较）
    const normalizedLower = normalized.toLowerCase()
    for (const line of existingLines) {
      const content = line
        .replace(/^-\s+\d{4}-\d{2}-\d{2}\s+/, '')
        .replace(/^-\s+/, '')
        .replace(/[\r\n\t\f\v ]+/g, ' ')
        .trim()
      if (content.toLowerCase() === normalizedLower) {
        return { ok: false, reason: 'duplicate', message: '已存在相同的表达偏好记录' }
      }
    }

    // 构建新记录
    const newLine = `- ${dateOf(now)} ${normalized}`
    const nextLines = [...existingLines, newLine]

    // 上限保护：若超出 VOICE_LEARNED_MAX_ENTRIES，按时间保留最新条目
    const keptLines = nextLines.slice(-VOICE_LEARNED_MAX_ENTRIES)
    const fileContent = keptLines.join('\n') + '\n'

    // 唯一临时文件
    voiceLearnedWriteSeq = (voiceLearnedWriteSeq + 1) & 0xffff
    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(bodyDir, `${VOICE_LEARNED_FILE}.tmp.${process.pid}.${Date.now()}.${voiceLearnedWriteSeq}.${rand}`)

    fs.mkdirSync(bodyDir, { recursive: true })
    fs.writeFileSync(tmpFile, fileContent, 'utf8')

    // 写盘替换前执行持锁凭据核验（Fencing Check），防止锁被接管后并发覆写
    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被其他操作接管或失效')
    }

    // 安全原子替换，不提前删除旧数据
    safeAtomicReplace(tmpFile, file)
    return { ok: true, file, line: newLine, entry: normalized }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    return { ok: false, reason: 'write-error', error: err.message, message: `写入失败: ${err.message}` }
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}

// ---------------------------------------------------------------- 身体

export function readBody(root, name) {
  const dir = ensureLayout(root)
  const file = path.join(dir, 'body', `${safeDevice(name)}.md`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

export function listBody(root) {
  const dir = path.join(resolveRoot(root), 'body')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md') && !n.endsWith('.previous'))
    .map((n) => n.slice(0, -3))
}

// ---------------------------------------------------------------- 记忆

/** 出处标记：永远能看出来源，猜不出来就写 unknown，绝不反推。 */
export const SRC_UNKNOWN = 'unknown'

/** 触发方式：chat=用户对话，self=插件自己起的回合（空闲/分发），unknown=认不出。 */
export const VIA_VALUES = ['chat', 'self', 'unknown']

export function normalizeSrc(src) {
  const raw = String(src ?? '').trim().replace(/\s+/g, '')
  if (!raw || raw.toLowerCase() === SRC_UNKNOWN) return SRC_UNKNOWN
  // 只收会话 id 这类安全字符，别让换行/井号把一行记忆搞坏
  if (!/^[A-Za-z0-9:._-]{1,96}$/.test(raw)) return SRC_UNKNOWN
  return raw
}

export function normalizeVia(via) {
  const raw = String(via ?? '').trim().toLowerCase()
  return VIA_VALUES.includes(raw) ? raw : 'unknown'
}

/**
 * 触发方式：user → chat；schedule/plugin（插件自己 followup）→ self；其余 unknown。
 */
export function viaOfSourceKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase()
  if (k === 'user') return 'chat'
  if (k === 'schedule' || k === 'plugin') return 'self'
  return SRC_UNKNOWN
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志是多帧 zstd 拼接；按 magic 切开。 */
export function zstdFrameStarts(buf) {
  const starts = []
  let i = 0
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) >= 0) {
    starts.push(i)
    i += ZSTD_MAGIC.length
  }
  return starts
}

/**
 * 从一段文字里找这一轮是谁起的：从后往前找第一条「真正的」user 消息。
 * 宿主会往会话里塞 time-context / runtime-context / skill-catalog 这类注入消息，
 * 它们不是人说的话，跳过；user → chat，schedule → self。
 */
export function kindFromSessionText(text) {
  let searchFrom = text.length
  for (;;) {
    const at = text.lastIndexOf('"type":"user/message"', searchFrom)
    if (at < 0) return ''
    const lineStart = text.lastIndexOf('\n', at) + 1
    const lineEnd = text.indexOf('\n', at)
    const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    try {
      const rec = JSON.parse(line)
      const kind = String(rec?.data?.source?.kind || '')
      if (kind === 'user' || kind === 'schedule') return kind
    } catch {
      // 行被帧切断了，继续往前
    }
    searchFrom = at - 1
  }
}

/**
 * 从会话日志里读这一轮是谁起的：最后一条 user 消息的 source.kind。
 * 从尾部往前解帧，找到就停；工具调用发生在消息落盘之后，所以日志是可靠证据。
 * 读不到就返回空串，交给调用方降级。
 */
export function sessionSourceKind(sessionsRoot, sessionId, { maxFrames = 256 } = {}) {
  const raw = String(sessionId ?? '').trim().replace(/^session-/, '')
  if (!raw || !fs.existsSync(sessionsRoot) || typeof zlib.zstdDecompressSync !== 'function') return ''
  const names = [`session-${raw}`, raw]
  const fileNames = ['session.v4.jsonl.zstd', 'session.jsonl.zstd']
  let file = ''
  for (const ws of fs.readdirSync(sessionsRoot)) {
    for (const name of names) {
      const dir = path.join(sessionsRoot, ws, name)
      if (!fs.existsSync(dir)) continue
      for (const fn of fileNames) {
        const candidate = path.join(dir, fn)
        if (fs.existsSync(candidate)) {
          file = candidate
          break
        }
      }
      if (file) break
    }
    if (file) break
  }
  if (!file) return ''
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return ''
  }
  const starts = zstdFrameStarts(buf)
  if (!starts.length) return ''
  let text = ''
  const limit = Math.max(1, maxFrames)
  for (let k = starts.length - 1; k >= 0 && starts.length - k <= limit; k--) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try {
      text = zlib.zstdDecompressSync(slice).toString('utf8') + text
    } catch {
      continue
    }
    const kind = kindFromSessionText(text)
    if (kind) return kind
  }
  return ''
}

/** 会话 id → 门牌：去掉 session- 前缀，取前 8 位，够在 sessions 目录里定位。 */
export function shortSessionId(id) {
  const raw = String(id ?? '').trim()
  if (!raw) return SRC_UNKNOWN
  const bare = raw.replace(/^session-/, '')
  return /^[A-Za-z0-9_-]{6,}$/.test(bare) ? bare.slice(0, 8) : SRC_UNKNOWN
}

export const SRC_INDEX_FILE = 'src-index.json'
const SRC_INDEX_MAX = 500

/**
 * 门牌本：8 位 → 完整会话 id。行里只放 8 位，完整 id 放这里，
 * 要回原文时不用去 sessions 目录里猜。
 */
export function recordSrcIndex(root, short, sessionId, now = new Date()) {
  assertLegacyMemory(root)
  const src = normalizeSrc(short)
  const full = String(sessionId ?? '').trim().replace(/^session-/, '')
  if (src === SRC_UNKNOWN || !full) return null
  const dir = resolveRoot(root)
  const file = path.join(dir, SRC_INDEX_FILE)
  let index = {}
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch {
    index = {}
  }
  const at = now.toISOString()
  const entry = index[src] && typeof index[src] === 'object' ? index[src] : { count: 0 }
  entry.session = full
  entry.firstSeen = entry.firstSeen || at
  entry.lastSeen = at
  entry.count = (Number(entry.count) || 0) + 1
  index[src] = entry
  const keys = Object.keys(index)
  if (keys.length > SRC_INDEX_MAX) {
    keys
      .sort((a, b) => String(index[a].lastSeen || '').localeCompare(String(index[b].lastSeen || '')))
      .slice(0, keys.length - SRC_INDEX_MAX)
      .forEach((k) => delete index[k])
  }
  fs.writeFileSync(file, JSON.stringify(index, null, 2) + '\n', 'utf8')
  return entry
}

export function readSrcIndex(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveRoot(root), SRC_INDEX_FILE), 'utf8')) || {}
  } catch {
    return {}
  }
}

/** 拿门牌查完整会话：src 可以是 8 位，也可以给一段前缀。 */
export function traceSrc(root, src) {
  const key = String(src ?? '').trim().replace(/^session-/, '')
  if (!key) return null
  const index = readSrcIndex(root)
  if (index[key]) return { src: key, ...index[key] }
  const hit = Object.keys(index).find((k) => k.startsWith(key))
  return hit ? { src: hit, ...index[hit] } : null
}

/**
 * 追加一条记忆。provenance 可以是字符串（只给出处，兼容旧调用），
 * 也可以是 { src, via }。
 */
export function appendMemory(root, device, text, now = new Date(), provenance = {}) {
  assertLegacyMemory(root)
  const dir = ensureLayout(root)
  const dev = safeDevice(device)
  const file = path.join(dir, 'MEMORY', `${dateOf(now)}.${dev}.md`)
  const src = normalizeSrc(typeof provenance === 'string' ? provenance : provenance?.src)
  const via = normalizeVia(typeof provenance === 'string' ? '' : provenance?.via)
  const full = typeof provenance === 'object' && provenance ? provenance.session : ''
  if (full) recordSrcIndex(dir, src, full, now)
  const line = `- ${timeOf(now)} [${dev}] ${oneLine(text)} · src:${src} via:${via}\n`
  fs.appendFileSync(file, line, 'utf8')
  return { file, line: line.trim(), src, via }
}

/**
 * 给还没有出处的旧记忆补 `· src:unknown via:unknown`：只加标记，不改正文，不反推。
 * 幂等；每次启动跑一遍也不贵。
 */
export function migrateProvenance(root) {
  if (readMemoryMode(root) === 'external') return { files: 0, lines: 0, skipped: 'external-memory' }
  const dir = resolveRoot(root)
  const memDir = path.join(dir, 'MEMORY')
  if (!fs.existsSync(memDir)) return { files: 0, lines: 0 }
  let files = 0
  let lines = 0
  for (const name of fs.readdirSync(memDir)) {
    if (!/^\d{4}-\d{2}-\d{2}\..+\.md$/.test(name)) continue
    const file = path.join(memDir, name)
    const body = fs.readFileSync(file, 'utf8')
    let changed = false
    const next = body
      .split('\n')
      .map((line) => {
        if (!line.trim().startsWith('- ')) return line
        if (/ · src[:=]/.test(line)) return line
        changed = true
        lines++
        return `${line.replace(/\s+$/, '')} · src:${SRC_UNKNOWN} via:${SRC_UNKNOWN}`
      })
      .join('\n')
    if (changed) {
      fs.writeFileSync(file, next, 'utf8')
      files++
    }
  }
  return { files, lines }
}

export function recentMemoryFiles(root, days = 3) {
  const dir = path.join(resolveRoot(root), 'MEMORY')
  if (!fs.existsSync(dir)) return []
  const sinceKey = dateOf(new Date(Date.now() - days * 86400_000))
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\..+\.md$/.test(name))
    .filter((name) => name.slice(0, 10) >= sinceKey)
    .sort()
    .reverse()
    .map((name) => path.join(dir, name))
}

/**
 * 会话开始时注入：本子 + 最近几天的记忆。
 * 不注入 body（器官靠工具读），不注入任何默认人格。
 * 本子为空时只说它空着。
 */
export function readSelf(root, { days = 3, maxBytes = MAX_SELF_BYTES, includeLegacy = false } = {}) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const parts = []
  const notebook = readNotebook(dir).trim()
  const entries = notebook.split('\n').filter((l) => l.trim().startsWith('- '))
  parts.push(entries.length ? notebook : '# 本子\n\n（还是空的，你可以往里写。）')
  const external = readMemoryMode(dir) === 'external'
  if (external && !includeLegacy) {
    const self = notebook || '（本子为空；普通记忆请查询 Mnemon。）'
    return Buffer.byteLength(self) > maxBytes ? Buffer.from(self).subarray(0, maxBytes).toString('utf8') + '\n…(截断)' : self
  }
  if (external) parts.push(LEGACY_ARCHIVE_NOTICE)
  const facts = readFacts(dir).trim()
  if (facts.split('\n').some((l) => l.trim().startsWith('- '))) parts.push(facts)
  const files = recentMemoryFiles(dir, days)
  if (files.length) {
    const lines = []
    for (const file of files) {
      const body = fs.readFileSync(file, 'utf8').trim()
      if (body) lines.push(`### ${path.basename(file, '.md')}\n${body}`)
    }
    if (lines.length) parts.push('## 最近\n' + lines.join('\n'))
  }
  let out = parts.join('\n\n')
  if (Buffer.byteLength(out) > maxBytes) {
    out = Buffer.from(out).subarray(0, maxBytes).toString('utf8') + '\n…(截断)'
  }
  return out
}

/** 从一行记忆里取触发方式；老条目没有 via 字段，按 unknown 算。 */
export function viaOfLine(line) {
  const m = String(line).match(/ via:([A-Za-z]+)\s*$/)
  return m ? normalizeVia(m[1]) : SRC_UNKNOWN
}

export function recall(
  root,
  query,
  { days = 30, limit = 40, maxBytes = MAX_RECALL_BYTES, via = 'any' } = {},
) {
  const dir = resolveRoot(root)
  const needle = String(query || '').trim().toLowerCase()
  const want = String(via || 'any').trim().toLowerCase()
  const hits = []
  for (const file of recentMemoryFiles(dir, days)) {
    const base = path.basename(file, '.md')
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      if (needle && !line.toLowerCase().includes(needle)) continue
      if (want !== 'any' && viaOfLine(line) !== normalizeVia(want)) continue
      hits.push(`${base} ${line.trim()}`)
      if (hits.length >= limit) break
    }
    if (hits.length >= limit) break
  }
  let out = hits.join('\n')
  if (Buffer.byteLength(out) > maxBytes) {
    out = Buffer.from(out).subarray(0, maxBytes).toString('utf8') + '\n…(截断)'
  }
  if (readMemoryMode(root) === 'external' && hits.length) out = LEGACY_ARCHIVE_NOTICE + '\n' + out
  return { query: needle, via: want, count: hits.length, text: out }
}

export function stats(root) {
  const dir = ensureLayout(root)
  const notebook = readNotebook(dir)
  const memDir = path.join(dir, 'MEMORY')
  const files = fs.existsSync(memDir) ? fs.readdirSync(memDir).filter((n) => n.endsWith('.md') && n !== 'README.md') : []
  let entries = 0
  for (const name of files) {
    entries += fs
      .readFileSync(path.join(memDir, name), 'utf8')
      .split('\n')
      .filter((l) => l.trim().startsWith('- ')).length
  }
  return {
    root: dir,
    body: readProfile(dir)?.profile || 'unknown',
    notebookBytes: Buffer.byteLength(notebook),
    notebookEntries: notebook.split('\n').filter((l) => l.trim().startsWith('- ')).length,
    factEntries: readFacts(dir).split('\n').filter((l) => l.trim().startsWith('- ')).length,
    memoryFiles: files.length,
    memoryEntries: entries,
    organs: listBody(dir),
  }
}

// ---------------------------------------------------------------- 导出 / 导入

const BUNDLE_FORMAT = 'dsh-heart'

function collectFiles(dir) {
  const files = {}
  if (fs.existsSync(path.join(dir, 'notebook.md'))) {
    files['notebook.md'] = fs.readFileSync(path.join(dir, 'notebook.md'), 'utf8')
  }
  if (fs.existsSync(path.join(dir, 'facts.md'))) {
    files['facts.md'] = fs.readFileSync(path.join(dir, 'facts.md'), 'utf8')
  }
  for (const [sub, pattern] of [
    ['body', /\.md$/],
    ['MEMORY', /^\d{4}-\d{2}-\d{2}\..+\.md$/],
  ]) {
    const d = path.join(dir, sub)
    if (!fs.existsSync(d)) continue
    for (const name of fs.readdirSync(d)) {
      if (pattern.test(name)) files[`${sub}/${name}`] = fs.readFileSync(path.join(d, name), 'utf8')
    }
  }
  return files
}

export function exportBundle(root, now = new Date()) {
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const payload = {
    format: BUNDLE_FORMAT,
    schema: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    files: collectFiles(dir),
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'))
}

export function exportBundleToFile(root, file, now = new Date()) {
  if (readMemoryMode(root) === 'external') {
    const dir = resolveRoot(root)
    const roots = [dir]
    if (fs.existsSync(dir)) roots.push(fs.realpathSync(dir))
    const destinations = [path.resolve(file)]
    if (fs.existsSync(file)) destinations.push(fs.realpathSync(file))
    // 新输出文件也可能位于指向 MEMORY 的目录链接内；解析最近的已存在父目录。
    let parent = path.dirname(path.resolve(file))
    const suffix = [path.basename(file)]
    while (!fs.existsSync(parent) && path.dirname(parent) !== parent) {
      suffix.unshift(path.basename(parent))
      parent = path.dirname(parent)
    }
    if (fs.existsSync(parent)) destinations.push(path.join(fs.realpathSync(parent), ...suffix))
    for (const destination of destinations) for (const archiveRoot of roots) {
      const relative = path.relative(archiveRoot, destination).replace(/\\/g, '/').toLowerCase()
      const canonical = relative.split('/').map(part => part.replace(/[. ]+$/g, '')).join('/')
      if (canonical === 'facts.md' || canonical.startsWith('facts.md:') || canonical === 'src-index.json' || canonical.startsWith('src-index.json:') || canonical === 'config.json' || canonical.startsWith('config.json:') || canonical === 'memory' || canonical.startsWith('memory/')) {
        assertLegacyMemory(root)
      }
    }
  }
  const buf = exportBundle(root, now)
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, buf)
  return { file: path.resolve(file), bytes: buf.length }
}

function mergeLines(existing, incoming) {
  const set = new Set()
  for (const line of `${existing}\n${incoming}`.split('\n')) {
    const value = line.trim()
    if (value.startsWith('- ')) set.add(value)
  }
  return [...set].sort().join('\n') + '\n'
}

/**
 * 表达习惯按行合并与去重：
 * 1. 提取所有有效记录行（- 开头），按小写规范化偏好内容去重；
 * 2. 同一偏好存在时，保留较新日期的记录；
 * 3. 排序保持时间序，并严格限制不超过 VOICE_LEARNED_MAX_ENTRIES 条。
 */
export function mergeVoiceLearned(existingText, incomingText) {
  const parseLines = (text) =>
    String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))

  const existingLines = parseLines(existingText)
  const incomingLines = parseLines(incomingText)

  const extractContent = (line) =>
    line
      .replace(/^-\s+\d{4}-\d{2}-\d{2}\s+/, '')
      .replace(/^-\s+/, '')
      .replace(/[\r\n\t\f\v ]+/g, ' ')
      .trim()

  const extractDate = (line) => {
    const m = line.match(/^-\s+(\d{4}-\d{2}-\d{2})/)
    return m ? m[1] : ''
  }

  const map = new Map()

  for (const line of existingLines) {
    const content = extractContent(line)
    if (!content) continue
    const key = content.toLowerCase()
    map.set(key, { line, date: extractDate(line) })
  }

  for (const line of incomingLines) {
    const content = extractContent(line)
    if (!content) continue
    const key = content.toLowerCase()
    const date = extractDate(line)
    if (map.has(key)) {
      const prev = map.get(key)
      if (date && (!prev.date || date >= prev.date)) {
        map.set(key, { line, date })
      }
    } else {
      map.set(key, { line, date })
    }
  }

  const merged = Array.from(map.values()).sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) {
      return a.date.localeCompare(b.date)
    }
    if (a.date && !b.date) return 1
    if (!a.date && b.date) return -1
    return a.line.localeCompare(b.line)
  })

  const kept = merged.slice(-VOICE_LEARNED_MAX_ENTRIES)
  return kept.length ? kept.map((x) => x.line).join('\n') + '\n' : ''
}

/** 保守合并：本子与记忆按行求并集；身体已存在则跳过（force 才覆盖）。表达习惯独立走互斥锁与去重合并。 */
export function importBundle(root, buffer, { force = false } = {}) {
  // 整包可携带任意文件名（包括 config.json）；external 下原子拒绝，不能借导入恢复写权限。
  assertLegacyMemory(root)
  const dir = resolveRoot(root)
  ensureLayout(dir)
  const payload = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
  if (payload.format !== BUNDLE_FORMAT) throw new Error('不是 dsh-heart 的导出文件')
  const result = { merged: 0, written: 0, skipped: [] }
  for (const [rawName, text] of Object.entries(payload.files || {})) {
    assertLegacyMemory(root)
    // 路径规范化：统一转换为 POSIX 正斜杠，去除首部斜杠，并防御跨目录越界穿越
    const name = String(rawName || '').replace(/\\/g, '/').replace(/^\/+/, '')
    const target = path.resolve(dir, name)
    const rel = path.relative(dir, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      continue
    }

    if (name === 'notebook.md' || name === 'facts.md' || name.startsWith('MEMORY/')) {
      const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, mergeLines(existing, text), 'utf8')
      result.merged += 1
      continue
    }
    if (name === `body/${VOICE_LEARNED_FILE}`) {
      const bodyDir = path.join(dir, 'body')
      const lockDir = path.join(bodyDir, `${VOICE_LEARNED_FILE}.lock`)
      const lockToken = acquireDirLock(lockDir)
      if (!lockToken) {
        throw new Error('导入表达习惯失败：获取文件锁超时')
      }
      let tmpFile = null
      try {
        fs.mkdirSync(bodyDir, { recursive: true })
        let finalContent = ''
        if (force) {
          finalContent = typeof text === 'string' ? text : ''
          result.written += 1
        } else {
          // 锁内重新读取目标文件，避免锁外读取导致并发更新丢失
          const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
          finalContent = mergeVoiceLearned(existing, text)
          result.merged += 1
        }

        voiceLearnedWriteSeq = (voiceLearnedWriteSeq + 1) & 0xffff
        const rand = Math.random().toString(36).slice(2, 8)
        tmpFile = path.join(bodyDir, `${VOICE_LEARNED_FILE}.tmp.${process.pid}.${Date.now()}.${voiceLearnedWriteSeq}.${rand}`)
        fs.writeFileSync(tmpFile, finalContent, 'utf8')

        if (!isDirLockHeld(lockDir, lockToken)) {
          throw new Error('写盘前锁凭据校验失败：锁已被其他操作接管或失效')
        }

        safeAtomicReplace(tmpFile, target)
      } catch (err) {
        if (tmpFile && fs.existsSync(tmpFile)) {
          try { fs.unlinkSync(tmpFile) } catch {}
        }
        throw err
      } finally {
        releaseDirLock(lockDir, lockToken)
      }
      continue
    }
    if (fs.existsSync(target) && !force) {
      result.skipped.push(name)
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text, 'utf8')
    result.written += 1
  }
  return result
}

// ---------------------------------------------------------------- 迁移

export function migrate(root) {
  const dir = resolveRoot(root)
  let before = 0
  try {
    before = Number(JSON.parse(fs.readFileSync(path.join(dir, 'schema.json'), 'utf8')).version) || 0
  } catch {
    before = 0
  }
  if (readMemoryMode(root) === 'external') return { from: before, to: before, changed: false, skipped: 'external-memory' }
  ensureLayout(dir)
  // 出处标记：旧记忆补 unknown（幂等），跟 schema 版本无关，每次启动都跑。
  try {
    migrateProvenance(dir)
  } catch {
    // 迁移失败不能影响加载
  }
  // v2 → v3：交接不属于这个项目，删掉空目录；人格容器改名保留。
  if (before < 3) {
    for (const legacy of ['CORE.md', 'RELATIONSHIP.md']) {
      const src = path.join(dir, legacy)
      const dst = path.join(dir, `legacy-${legacy}`)
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst)
    }
    const handoff = path.join(dir, 'handoff')
    if (fs.existsSync(handoff) && fs.readdirSync(handoff).length === 0) fs.rmdirSync(handoff)
  }
  if (before >= SCHEMA_VERSION) return { from: before, to: before, changed: false }
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({ version: SCHEMA_VERSION }, null, 2) + '\n', 'utf8')
  return { from: before, to: SCHEMA_VERSION, changed: true }
}

// ---------------------------------------------------------------- 节律
// 身体的一部分：它自己按时间醒。醒来只做极轻的事——记一行时间线、看一眼自己的状态。
// 不调用模型、不打扰任何人；需要判断的事留到有人说话时再做。

export const PULSE_LOG = 'pulse.log'
export const PULSE_MAX_LINES = 500

/** 一次醒来：记一行。返回这一行和它看到的东西。 */
export function pulseTick(root, now = new Date()) {
  const dir = ensureLayout(root)
  const file = path.join(dir, PULSE_LOG)
  const memories = recentMemoryFiles(dir, 3650)
  let oldestDays = 0
  if (memories.length) {
    const oldest = path.basename(memories[memories.length - 1]).slice(0, 10)
    const diff = Date.now() - new Date(`${oldest}T00:00:00`).getTime()
    oldestDays = Math.max(0, Math.floor(diff / 86400_000))
  }
  const hint = oldestDays > 30 ? ` hint=旧记忆${oldestDays}天` : ''
  const line = `${dateOf(now)} ${timeOf(now)} wake${hint}`
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  lines.push(line)
  const kept = lines.slice(-PULSE_MAX_LINES)
  fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8')
  return { file, line, ticks: kept.length, oldestDays }
}

export function readPulse(root, { limit = 20 } = {}) {
  const file = path.join(resolveRoot(root), PULSE_LOG)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
}

// ---------------------------------------------------------------- 配置
// 宿主每次启动会重写 cordis.yml，插件 config 会被抹掉。
// 所以节律参数放在 heart/config.json —— 数据归数据，不跟宿主配置打架。

export const DEFAULT_IDLE_CATEGORIES = [
  { id: 'bilibili', label: 'B站', dailyCap: 4 },
  { id: 'fun', label: '娱乐', dailyCap: 2 },
  { id: 'study', label: '学习', dailyCap: 2 },
  { id: 'rest', label: '休息', dailyCap: 6 },
]

export const DEFAULT_CONFIG = {
  memoryMode: 'legacy',
  pulse: false,
  pulseSeconds: 60,
  sense: true,
  awayMinutes: 30,
  triggerOnReturn: true,
  triggerCooldownMinutes: 360,
  senseLogMax: 500,
  sensePhonePowerEveryMinutes: 5,
  injectPrompt: true,
  promptNotebookLines: 6,
  promptFactsLines: 12,
  promptFacts: true,
  idleTurns: true,
  idleTurnMinutes: 6,
  idleTurnMinMinutes: 6,
  idleTurnDefaultMinutes: 30,
  idleTurnMaxMinutes: 180,
  idleTurnDailyCap: 6,
  idleCategories: DEFAULT_IDLE_CATEGORIES,
}

export function readHeartConfig(root) {
  const file = path.join(resolveRoot(root), 'config.json')
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')), memoryMode: readMemoryMode(root) }
  } catch {
    return { ...DEFAULT_CONFIG, memoryMode: readMemoryMode(root) }
  }
}

export function writeHeartConfig(root, patch) {
  if (patch.memoryMode !== undefined && !['legacy', 'external'].includes(patch.memoryMode)) throw new Error('memoryMode 只能为 legacy 或 external')
  const dir = resolveRoot(root)
  fs.mkdirSync(dir, { recursive: true })
  const next = { ...readHeartConfig(dir), ...patch }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ---------------------------------------------------------------- 开口
// 动态档位：不是固定每天几次，而是按「你回不回我」自己升降。
// 档位存在 heart/speak.json，可见、可改、可被你一票否决。

export const SPEAK_DEFAULT = {
  level: 10,
  maxLevel: 10,
  usedToday: 0,
  ignoredStreak: 0,
  lastSpokeAt: null,
  lastSpokeDate: null,
  quietFrom: '23:00',
  quietTo: '08:00',
  target: '',
}

export function readSpeak(root) {
  const file = path.join(resolveRoot(root), 'speak.json')
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    data = {}
  }
  return { ...SPEAK_DEFAULT, ...data }
}

export function writeSpeak(root, patch) {
  const dir = ensureLayout(root)
  const next = { ...readSpeak(dir), ...patch }
  fs.writeFileSync(path.join(dir, 'speak.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** 安静时段：跨午夜也成立（23:00–08:00）。 */
export function inQuietHours(now, from, to) {
  const f = minutesOf(from)
  const t = minutesOf(to)
  if (f === null || t === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return f <= t ? cur >= f && cur < t : cur >= f || cur < t
}

/** 今天还能不能说；说明理由，便于面板显示和自查。 */
export function canSpeak(root, now = new Date()) {
  const state = readSpeak(root)
  if (inQuietHours(now, state.quietFrom, state.quietTo)) return { ok: false, reason: 'quiet-hours', state }
  const today = dateOf(now)
  const used = state.lastSpokeDate === today ? state.usedToday : 0
  if (used >= state.level) return { ok: false, reason: 'budget', state: { ...state, usedToday: used } }
  return { ok: true, reason: 'ok', state: { ...state, usedToday: used } }
}

export function consumeSpeak(root, now = new Date()) {
  const state = readSpeak(root)
  const today = dateOf(now)
  const used = (state.lastSpokeDate === today ? state.usedToday : 0) + 1
  return writeSpeak(root, {
    usedToday: used,
    lastSpokeDate: today,
    lastSpokeAt: now.toISOString(),
  })
}

// ---------------------------------------------------------------- 待发
// 「有东西要给你」时先入队，醒来时再看能不能说。交付类不受预算限制。

export function enqueueSay(root, text, kind = 'delivery', session = '') {
  const dir = ensureLayout(root)
  const file = path.join(dir, 'outbox.json')
  let items = []
  try {
    items = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    items = []
  }
  const item = { text: oneLine(text, 600), kind, at: new Date().toISOString() }
  // 说这句话时所在的窗口。旧条目没有这个字段，投递时再退回全局目标。
  if (session) item.session = String(session)
  items.push(item)
  if (items.length > 50) items = items.slice(-50)
  fs.writeFileSync(file, JSON.stringify(items, null, 2) + '\n', 'utf8')
  return { item, count: items.length }
}

export function readOutbox(root) {
  const file = path.join(resolveRoot(root), 'outbox.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

export function takeSay(root) {
  const items = readOutbox(root)
  if (!items.length) return null
  const [first, ...rest] = items
  fs.writeFileSync(path.join(resolveRoot(root), 'outbox.json'), JSON.stringify(rest, null, 2) + '\n', 'utf8')
  return first
}

// ---------------------------------------------------------------- 情绪感知（Mood）
export {
  readMood,
  readPersistedMood,
  updateMood,
  resetMood,
  getEffectiveMood,
  isValidPersistedMood,
  calculateDecayedIntensity,
  validateMoodCandidate,
  shouldUpdateMood,
  createDefaultMood,
  formatMoodPrompt,
  MOOD_STATES,
  MOOD_REASONS,
  STATE_REASON_MATRIX,
  LOW_INTENSITY_THRESHOLD,
  DEFAULT_HALF_LIFE_MS,
  MOOD_FILE,
  MOOD_SCHEMA_VERSION,
  BASELINE,
  HALF_LIFE_MS,
  decayDimension,
  calculateDistanceToBaseline,
  deriveDominantState,
  normalizeToV2,
  mapStateTo3DImpulse,
  format3DMoodPrompt,
} from './mood.js'

// ---------------------------------------------------------------- 经验沉淀（Dream）
export {
  readInsights,
  saveInsights,
  updateInsightStatus,
  filterSessionMessages,
  parseModelInsights,
  generateInsightId,
  validateCandidateInsight,
  applyInsightTransition,
  normalizeStatement,
  DREAM_DIR,
  INSIGHTS_FILE,
  INSIGHTS_LOCK,
  INSIGHT_CATEGORIES,
  INSIGHT_TYPES,
  INSIGHT_STATUSES,
  promoteInsight,
  resolvePromotionTarget,
} from './dream.js'

// ---------------------------------------------------------------- 结构化分区日志（Logs）
export {
  log,
  logEvent,
  readModuleLogs,
  LOG_MODULES,
  LOG_LEVELS,
  LOGS_DIR,
  MAX_LOG_SIZE_BYTES,
  sanitizeLogData,
} from './logger.js'


