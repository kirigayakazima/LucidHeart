# Changelog

All notable changes to this project will be documented in this file.

## [0.20.0] - 2026-10-31

### Added
- **Heart Protocol v1 & 微内核架构演进**：
  - 冻结 Heart 最小公共协议边界，建立独立 `contracts/` 目录并导出契约规范与校验器（`HEART_PROTOCOL_VERSION = '1.0.0'`）。
  - 实现 Cordis `HeartService` 微内核服务，通过 `ctx.provide('heart', service)` 暴露标准服务能力。
  - **只读快照**：`heart.getSnapshot()` 获取内部情绪（Mood 2.0 三维值与原因）、在线状态（presence）、空闲额度与版本信息，对象全冻结（Object.freeze）防篡改。
  - **安全感知接入**：`heart.observe(input)` 接收外部事实性感知，严格禁止外部直写情绪三维数值（valence/arousal/energy/state），由 Heart 策略引擎依据置信度与事实证据映射至状态机，状态变更时触发通知。
  - **活动适宜性评估**：`heart.evaluateActivity(intent)` 提供非紧急自主活动适宜性建议（检查安静时段、日额度/类别上限、疲惫心境劝阻），不承担外部执行授权。
  - **Cordis 事件契约**：
    - `heart/state-changed`：状态变更并发通知（提供 prev/current/eventSource），表达器官（Live2D、语音等）安全监听。
    - `heart/idle`：空闲条件满足通知，习惯插件（bili-scroll 等）自主监听评估。
  - **三种交互边界彻底厘清**：感知提交事实、通知单向广播、执行由各插件独立暴露服务与 DSH 工具（杜绝异步 consumed=true 竞争与假成功）。
  - **跨设备感官扩展边界（FullAwake）**：手机 DSHA 为唯一主脑，PC Gateway 通过网络 Bridge/MCP 动态上线/下线能力，严格隔离阿醒数据。
  - **架构负荷守恒**：零新增 LLM 模型工具（工具数量保持 18 个），系统提示词零膨胀。
  - **全量测试与验收**：新增 Protocol v1 契约测试、HeartService 测试以及包含三大轻量模拟插件（Sensory, Voice, PC Bridge）的热插拔生命周期验收测试。全量 166/166 项自动化测试 100% 通过。


## [0.19.0] - 2026-10-30

- 新增 root/config.json 的 legacy/external 记忆职责模式；默认 legacy。
- external 在存储层保护旧 facts/MEMORY，阻止 write/revise/discard、CLI、整包导入和导出覆盖等旁路；跳过旧档案迁移。
- 停止旧 facts 自动注入，旧档案通过有来源标记的只读查询访问。
- 保留 Mood/Voice/Notebook/Body/Sense/Trigger。Dream 保留 Voice 与显式声明的 Notebook 自我原则晋升，拒绝事实晋升。
- 增加 external 边界、旧档案不变及回退测试；不增加 Mnemon 内部接口依赖。

## [0.15.3] - 2026-10-26

### Added
- **表达习惯进化（Voice Evolution）**：
  - 新增 `body/voice-learned.md`，支持通过 `heart_voice_learn` 记录从相处中学习到的表达习惯；
  - 自动去重与上限淘汰（最多 100 条），提示词安全注入（逆序最多 6 条、总计 800 字限制并做防指令注入净化）；
  - `importBundle` 跨平台路径规范化与目录穿越防御，导入时支持去重合并与互斥锁保护。
- **情绪感知状态机（Mood）**：
  - 独立 `lib/mood.js` 模块，采用低自主性离散状态机（`calm`, `engaged`, `cheerful`, `excited`, `tired`）；
  - `STATE_REASON_MATRIX` 状态原因映射矩阵约束，`deep_work` 严格收敛至仅 `tired`（0.2~0.6），严禁将疲劳作为拒绝任务的理由；
  - 惰性指数衰减（读时纯内存计算，半衰期 2 小时，<= 0.15 阈值自动归零回归 calm），时钟倒退防御与有效状态微小变化抑制；
  - 导出统一纯函数 `isValidPersistedMood`，严格校验持久化记录（强度 `[0.0, 1.0]`，合法时间戳）；损坏数据只读安全回退 calm，磁盘现场 100% 留存；
  - 提示词预定义文案纯净隔离，`heart_mood` 工具注册。
- **存储与测试**：
  - 复用目录锁跨进程并发保护与僵尸锁自愈机制；
  - 新增 47 项专项测试（Voice Learn 31 项 + Mood 16 项），全量 113/113 项自动化测试保持 100% 通过。

## [0.15.2] - 2026-10-23

### Fixed
- `via` 在对话里被误记成 `unknown`：内存里的会话消息拿不到，改成从会话日志倒着解 zstd 帧、
  找最后一条真正的 user 消息。宿主注入的 `time-context` / `runtime-context` / `skill-catalog` 跳过，
  只认 `user`（→ chat）和 `schedule`（→ self）。
- 会话日志是多帧 zstd 拼接，Node 的流式解压只吃第一帧，这里按 magic 切帧逐帧解。
- 新增 `kindFromSessionText()` / `viaOfSourceKind()` / `zstdFrameStarts()`，都有单测。
- 代价：写一条记忆多约 0.17 秒（解尾部帧，找到即停）。

## [0.15.1] - 2026-10-23

### Added
- `heart/src-index.json`：8 位门牌 → 完整会话 uuid（含出现次数、首次/最近时间，上限 500 条，超出按最近时间淘汰）。
- `heart_trace(src)`：拿行尾门牌换回完整会话 id，并给出 `sessions/*/<uuid>/` 位置；查不到就说查不到。
- store 单测 29/29。

## [0.15.0] - 2026-10-23

按她的需求文档（`heart-provenance/README.md`）定稿出处格式：

### Changed
- 行尾改成 `· src:<会话 id 前 8 位> via:<chat|self|unknown>`（0.14.0 的 `src=<完整 id>` 作废，未发布给任何设备）。
- `via` 判断这一回合是谁起的：最后一条 user 消息 `source.kind` 为 `user` → `chat`，`schedule`/`plugin` → `self`。
- `heart_recall` 新增 `via` 过滤：`any` / `chat` / `self` / `unknown`。

### Added
- `migrate()` 启动时给旧记忆补 `· src:unknown via:unknown`（幂等、只加标记、不反推）。
- `shortSessionId()` / `normalizeSrc()` / `normalizeVia()` / `viaOfTurnMessages()`，都有单测。
- store 单测 27/27。

## [0.14.0] - 2026-10-23

### Added
- **记忆出处**：`heart_write(kind=memory)` 在行尾记 `· src=<会话 id>`，能顺着会话日志追到原文；拿不到会话就写 `src=unknown`。
- **旧记忆补标记**：`migrate()` 启动时给没有出处的历史记忆补 `· src=unknown`，幂等、只加标记不改正文、不反推。
- `normalizeSrc()`：出处只收安全字符，脏值（带空格/换行）一律降级成 `unknown`，不让一行记忆被写坏。
- 单测 27/27（store），全部 6 个测试文件通过。

## [0.13.0] - 2026-10-21

### Added
- **空闲活动分品类**：`idleCategories` 默认 `B站 / 娱乐 / 学习 / 休息`，各自有每日上限；`heart_next(minutes, category)` 记一次并排下一次，额度用完会拒绝。
- 所有类别都用完时，空闲触发直接 `category-cap`，不再空转烧 token；总数 `idleTurnDailyCap` 仍是总闸。
- 设置页「心」面板新增额度编辑：总数、每类上限、增删类别，保存写入 `heart/config.json`；节律每拍重读，立即生效。
- `GET /api/dsh-heart/state` 增加 `idle`；新增 `POST /api/dsh-heart/config`。
- 单测 52/52。

## [0.12.0] - 2026-10-21

### Added
- **下一次空闲回合由模型自己排**：新增 `heart_next(minutes)`，在 6–180 分钟之间设置 `nextIdleAt`；空闲回合的提示词会提醒她用。没排就按 `idleTurnDefaultMinutes`（30）兜底。
- 空闲触发改为看 `nextIdleAt` + `idleTurnMinMinutes`（默认 6 分钟）：不再用固定 gap。她可以在 6 分钟后再来搭话，也可以判断“现在没什么事”排到 60 分钟后。
- 配置：`idleTurnMinMinutes`、`idleTurnDefaultMinutes`、`idleTurnMaxMinutes`；`idleTurnGapMinutes` 退役。
- 单测 50/50。

## [0.11.0] - 2026-10-21

### Added
- **空闲自主回合**：她一个人待着时，允许模型自己起一轮。条件：presence 是 `nearby`/`away`、距上次消息 ≥ `idleTurnMinutes`（默认 30）、不在安静时段、当日未超 `idleTurnDailyCap`（6）、距上次空闲回合 ≥ `idleTurnGapMinutes`（60）。触发后走 `agent.followup`，提示词是「你一个人…想干点什么就干，不用等指令」。
- 触发优先级：`returned`（他回来）优先，其次 `idle`（他不在）。
- 配套单测：空闲条件、安静时段、配额、间隔、实际起一轮并记录 `trigger.json`（49/49）。

## [0.10.1] - 2026-10-21

### Fixed
- **手机端设备桥解析**：`/app/device` 实际返回 `{"result":"model=...\nscreen=on\n..."}`，之前把整个 JSON 当纯文本匹配，`screen`/`net` 经常拿不到。现在先解包 `result` 再解析 key=value，兼容纯文本和扁平 JSON；补 4 个单测（47/47）。

## [0.10.0] - 2026-10-21

### Added
- **把「心」放回每轮上下文**：`inject` 增加 `systemPrompt`，注册两节：
  - `heart:voice`（order 50）：`body/voice.md` + `body/senses.md`，她自己的嘴和耳朵；
  - `heart:self`（order 55）：本子最近 N 条 + 事实最近 M 条。
  每轮装配时现读文件；空文件自动跳过。不是人设，是把她写下的东西读给她听。
- 新工具 `heart_prompt`：查看这两节的实际内容与长度，方便验证。
- 新配置：`injectPrompt`（默认 true）、`promptNotebookLines`（6）、`promptFactsLines`（12）、`promptFacts`（true）。

## [0.9.2] - 2026-10-21

### Fixed
- **重启跨进程的 away 状态残留**：`applyPresence` 在 `isStartup` 首拍丢弃上一次进程的 `prev`。原先只跳过首拍触发，第二拍仍会把上次退出时的 `awaySince` 当成本次离开，隔天重启会误报“离开了 3000+ 分钟”。补单测后 40/40。

## [0.9.1] - 2026-10-21

### Fixed
- **离开时长精确化**：在 `sense.json` 中维护 `awaySince` 离开起点时间戳，`shouldTriggerReturned` 严格以离开起点计算时长，彻底解决离开后打字（`sinceMsgMin=0`）漏判或沉默后离开短时间误判的问题。
- **重启防误判机制**：`applyPulse` 首次唤醒只写状态不触发；若 `prev.at` 距当前时间超过 3 个节律周期，判定为中断重启（`startup`），防止加载旧状态误触发 `returned`。
- **安静时段统一**：`applyPresence` 与 `shouldTriggerReturned` 统一读取 `speak.json` 的 `quietFrom` / `quietTo`，消灭两套规则不一致。
- **前台窗口空闲净化**：Windows 采样过滤 `Idle |` 等无前台窗口伪进程，规范日志与状态展示。
- **模块解耦与性能优化**：
  - 将 `getSinceMsgMin` 收归 `lib/sense.js`，解除 `sense-phone` 对 `sense-win` 的不合理依赖。
  - 手机端精简掉沉重的 `dumpsys power`（省去 224KB/5min 读盘开销）。
  - 为 `findSessionMtimes` 增加 10 秒短期缓存，同一 tick 内避免重复全量遍历 200+ 会话文件。

## [0.9.0] - 2026-10-21

### Added
- **智能感知系统 (`lib/sense.js`, `lib/sense-win.js`, `lib/sense-phone.js`)**：
  - 在 60 秒节律中采样系统空闲、前台窗口与最新消息活跃度。
  - 状态判定与双采样去抖：`present`（活跃）、`nearby`（附近）、`away`（离开）、`asleep`（安静时段）。
  - 原子写入 `sense.json`，追加环形 500 行 `sense.log`。
  - Windows 环境基于 PowerShell P/Invoke 采样；手机端基于 3090 设备桥与 adb-shell 采样。
- **主动开口触发机制 (`lib/trigger.js`)**：
  - `returned` 事件：用户离开后回来主动触发 `agent.followup` 由模型决定开口内容。
  - 会话路由精准定位：按 session 文件最新 `mtime` 定位用户正在查看的活跃窗口，找不到或并列时静默等待，绝不盲投退回 `list()[0]`。
  - 触发状态与冷却记录于 `trigger.json`，默认 360 分钟冷却；安静时段（23:00–08:00）静默。
- **CLI 与工具**：
  - 新增独立命令行工具 `node bin/sense.js`，无 DSH 依赖，即跑即出采样 JSON。
  - 新增工具 `heart_sense`，供随时查看当前感知状态。
  - 面板状态路由 `/api/dsh-heart/state` 增加 `sense` 与 `trigger` 字段。
