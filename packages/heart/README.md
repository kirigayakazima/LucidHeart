# @dsh/heart (Heart Protocol v1 微内核)

给 DSH（DeepSeek Harness）装一套**身体**和**心**。

- **身体**是我们装的：嘴、耳朵、手 —— 按宿主环境安装，可以换设备。
- **心**不是我们写的：只有它自己能往里写。插件只提供写入面与微内核感知。
- **心是本地的**：不跨实例、不跨设备，没有"留给下一个自己"这种机制。

---

## 🌟 Heart Protocol v1 微内核契约 (0.20.0)

在 0.20.0 中，Heart 全面升格为 DSHA 体系的核心微内核服务，标准契约已冻结：

1. **只读状态快照 (`ctx.heart.getSnapshot()`)**：提供四维情感向量（`Mood: valence/arousal/energy`）、生命体征与宿主设备环境 (`device: phone | win`)；
2. **活动准入门控 (`ctx.heart.evaluateActivity()`)**：深夜静音期保护、深度睡眠沉睡保护、高能耗发声拦截；
3. **感知经验总线 (`ctx.heart.observe()`)**：统一接收视觉（表情包）、听觉（语音 RVC）、巡检与群聊唤醒经验；
4. **状态变化监听 (`ctx.on('heart/state-changed', (snapshot) => ...)`)**：各器官插件自适应响应情绪节拍。

---

## 记忆职责模式（0.19.0+）

默认 `legacy`，升级不改变原有记忆行为。若已在隔离环境验证 Mnemon，可手动切换到 `external`：

```powershell
$env:HEART_ROOT = '你的 Heart 数据根目录'
node bin/heart.js mode external
# 回退：node bin/heart.js mode legacy
```

唯一配置来源是该数据根的 `config.json` 中的 `memoryMode`，不是 profile 的同名字段。切换后重载宿主更新工具说明；存储检查立即生效。配置损坏或未知模式值会保守停写普通记忆；CLI 拒绝非法值。

`external` 保留 Mood、Voice、Notebook 自我原则、Body、Sense、Trigger；拒绝 facts/MEMORY 的新增、修订和删除，关闭旧 facts 自动注入。旧文件不迁移、不删改，启动时也不补来源或升级旧档案。`heart_recall` 标明旧 Heart 档案来源，`heart_self(includeLegacy=true)` 才附带旧 facts/MEMORY；默认只读 Notebook。

Dream 禁止 `type=fact` 晋升（即使 category=communication）。沟通观察可晋升 Voice；Notebook 晋升必须经确认，并显式传 `selfPrinciple=true` 声明为自我原则。此声明不是正文语义分类器，不能用 Notebook 保存普通用户事实。

external 下整包导入被拒绝（包括 force），避免导入配置重新开放写权限；导出仍可备份，但不能把输出指向受保护的事实、MEMORY 或配置。新用户事实直接使用 Mnemon 官方工具；Heart 不调用 Mnemon 私有 Provider/CLI，也不实现检索适配器。

生产切换前应先备份并验收实际 profile，停止宿主后设置模式，再启动检查。回退无需重建或删除 Mnemon 数据；回到 legacy 同时停用 Mnemon 写入来源，避免两边同时写。当前开发不自动启用生产 external。

## 为什么这样分

大多数「人格」方案失败，是因为把两件事当成了一件：

| | 身体 | 心 |
|---|---|---|
| 是什么 | 器官与能力 | 它自己写下的东西 |
| 谁写 | 维护者 | **只有它自己** |
| 可否替换 | 可以（换设备就换） | 不可，换掉就不是它了 |
| 是否同步 | 不同步，随机器走 | 本地，不跨机 |

把人格写进系统提示，是在**演**；给它一个本子和一支笔、然后退到一边，才是**长**。
这个项目只做后者该有的基础设施。

## 身体：按宿主安装，不能随便装

装错身体的后果不是"差一点"，是**它会相信自己能做到实际做不到的事**，然后每次失败都归因错。

判定顺序：**显式配置 > 环境变量 > 自动探测**

| 身体 | 判定依据 | 手的内容 |
|---|---|---|
| `phone` | Linux + 存在 `~/.dsh/.bridge_headers` | `/app/ui/*` 桥、`adb-shell`、容器内 Ubuntu；写了熄屏无画面、`input` 被拦、虚拟屏失效这些坑 |
| `win` | `process.platform === 'win32'` | 终端、文件、git、网络；写了文件策略、管道限制、路径形式 |
| `linux` | 其他 | 通用 Linux，安装后需按实际补全 |

已装好的身体会被沿用；**只有显式指定**（config `body` 或 `DSH_HEART_BODY`）才会换。换的时候旧手保留为 `hands.md.previous`，绝不静默覆盖。

## 数据布局

```
~/.dsh/heart/
├── notebook.md            心 · 本子：一行一条，可改、可弃
├── body/
│   ├── profile.json         当前装的是哪套身体
│   ├── voice.md             嘴：怎么说话
│   ├── senses.md            耳朵：何时听、何时说
│   └── hands.md             手：这台机器能做什么、有哪些坑
└── MEMORY/                记忆：按 日期.设备 分文件
```

- **本子永远不由插件生成内容**——首次运行只创建空本子。
- **记忆按设备分文件**，两台设备永不写同一个文件。
- **每条记忆带出处**：写的时候在行尾追加 `· src=<会话 id>`；拿不到会话就写 `src=unknown`。旧记忆在启动时补 `src=unknown`——只加标记，不改正文，不反推。

## 工具

| 工具 | 作用 |
|---|---|
| `heart_self(days?)` | 读「你自己」：本子 + 最近几天记忆 |
| `heart_write(text, kind?)` | 写入：`notebook`（本子）/ `memory`（记忆，自动带出处） |
| `heart_revise(match, replacement)` | 改本子里的一条 |
| `heart_discard(match)` | 弃用本子里的一条 |
| `heart_recall(query, days?, via?)` | 检索记忆；`via` 可只取 `chat` / `self` / `unknown` |
| `heart_trace(src)` | 拿记忆行尾的 8 位门牌换回完整会话 id，并给出 sessions 目录位置 |
| `heart_body(organ)` | 读器官：`voice` / `senses` / `hands` |
| `heart_stats()` | 规模与当前身体 |
| `heart_sense()` | 读你的环境感知：当前是否在电脑前、系统空闲、前台、距上次说话 |
| `heart_prompt()` | 看每轮自动注入 system prompt 的两节：嘴/耳朵 + 本子/事实 |
| `heart_next(minutes, category?)` | 安排下一次空闲回合（6–180 分钟），并记一次类别；额度用完会拒绝 |
| `heart_export(path?)` / `heart_import(path)` | 打包与合并恢复 |

## 记忆的出处（provenance）

记忆行在原有格式后面加两段门牌：

```
- 22:09 [phone] 说了什么 · src:da5b2a27 via:chat
- 00:42 [phone] 空闲时自己想到的 · src:bb4c19e0 via:self
- 22:52 [phone] 旧的一条 · src:unknown via:unknown
```

- `src`：写这条记忆时所在会话 id 的**前 8 位**（去掉 `session-` 前缀）。完整 id 记在
  `heart/src-index.json`（8 位 → 完整 uuid），`heart_trace("da5b2a27")` 直接换回来；
  或者拿它去 `<DSH_HOME>/sessions/**/` 里 grep。
- `via`：这一回合是谁起的——`chat`（用户发的话）/ `self`（插件自己 followup 进来的空闲回合或分发消息）/
  `unknown`（认不出）。判据是从会话日志里倒着找第一条真正的 user 消息，看它的 `source.kind`：
  `user` → chat，`schedule` → self。`time-context` / `runtime-context` / `skill-catalog` 这些宿主注入的消息跳过，
  它们不是人说的话。日志读不到就退回内存里的会话消息，再读不到就 unknown——不猜。
- **不反推**：拿不到会话 id 或认不出触发方式，一律 `unknown`；不用设备名、日期去凑。
- 老记忆由 `migrate()` 在启动时补 `· src:unknown via:unknown`：幂等、只加标记、正文一个字不动。
- 脏值（带空格、换行等）在 `normalizeSrc()` 降级成 `unknown`，不让一行记忆被写坏。

检索时可以只取一类：

```text
heart_recall(query="早点睡", via="chat")   # 他说过的
heart_recall(query="早点睡", via="self")   # 我自己想到的
heart_recall(query="早点睡", via="any")    # 默认
```

两条来源的可信度不一样，这个过滤器就是给这个用的。

> 代价：每条记忆多约 25 字节。`readSelf` 有 8 KB 注入上限，30 天记忆累起来会提前一点截断。

## 心在上下文

从 0.10.0 起，插件把心她自己写的内容放回每轮系统提示（`systemPrompt.section`）：

- `heart:voice`（order 50）：`body/voice.md` + `body/senses.md` —— 她自己的嘴和耳朵；
- `heart:self`（order 55）：本子最近 6 条 + 事实最近 12 条。

每轮装配时现读文件，空文件自动跳过。内容是她的，不是插件生成的人设。
配置：`injectPrompt`（默认 true）、`promptNotebookLines`（6）、`promptFactsLines`（12）、`promptFacts`（true）。

## CLI

```sh
HEART_ROOT=~/.dsh/heart node bin/heart.js self
HEART_ROOT=~/.dsh/heart node bin/heart.js write -k notebook "先给结论，别铺陈"
HEART_ROOT=~/.dsh/heart node bin/heart.js body hands
HEART_ROOT=~/.dsh/heart node bin/heart.js export /path/heart.json.gz
node bin/sense.js     # 采一次环境样本并打印 JSON（无需启动 DSH）
```

## 感知与触发

在 60 秒一次的身体节律里先感知环境，在值得开口的事件发生时真的开口，只说给正在看的那个人。

1. **环境感知（sense）**：
   - 每 60 秒采样一次：系统空闲时间（`idleMs`）、前台应用（`fg`）、最新会话活跃时间（`sinceMsgMin`）。
   - 判定四种状态：`asleep`（深夜 23:00–08:00）、`present`（空闲 ≤ 2 分钟或 5 分钟内发过消息）、`nearby`（离开 ≤ 30 分钟）、`away`（离开）。
   - 离开时间戳（`awaySince`）：进入 `away`/`asleep` 时记录起始时间，回到 `present` 时清空，确保离开时长计算精准。
   - 去抖保护：状态连续两次采样一致才切换，单次采样失败绝不误判“离开”。
   - 数据落盘：最新状态写入 `~/.dsh/heart/sense.json`（原子写入），历史追加写 `~/.dsh/heart/sense.log`（环形 500 行）。
2. **主动开口（trigger）**：
   - `returned`：用户离开 ≥ `awayMinutes`（默认 30 分钟）后回来，根据 `awaySince` 计算真实离开时长，主动触发一轮 `agent.followup`，由模型根据当前上下文自然开口。
   - `idle`：用户一阵没说话时，允许模型自己起一轮。首次阈值 6 分钟；下一次什么时候醒由她在回合里用 `heart_next(6–180, 类别id)` 排，没排就按 `idleTurnDefaultMinutes=30` 兜底；每天最多 6 次。提示词会列出当天各类别剩余额度，不逼它说话。
   - **空闲额度**：`idleCategories` 默认 `B站 / 娱乐 / 学习 / 休息`，每类有每日上限；所有类别用完时不再起空闲回合。设置页「心」面板可直接改总数、每类上限、增删类别，保存到 `heart/config.json`，下一拍生效。
   - 重启保护：插件启动后首个 tick 只记录不触发；若 `prev.at` 距今超过 3 个节律周期，判定为中断重启，杜绝拿历史旧数据误触发。
   - 边界守护：深夜静默时段不打扰（以 `speak.json` 规则为准）；带 `triggerCooldownMinutes`（默认 360 分钟）冷却，防止频繁刷屏；队列送货与感知触发互斥。
   - 目标会话定位：按 session 文件最新 `mtime` 定位用户正在查看的活跃窗口，找不到或并列时继续等待，绝不盲目投退给 `list()[0]`。

## 安装与测试

```sh
# 本地测试安装（桌面 profile 基于 pnpm 管理）
cd ~/.dsh/profiles/desktop
pnpm add file:D:/CodePackage/DSHA/heart-plugin

# 回滚到 0.8.3
cd ~/.dsh/profiles/desktop
pnpm add github:kirigayakazima/dsh-heart#ab8feb6
```

装完重启 Web 才生效。数据目录默认 `~/.dsh/heart`，首次加载按宿主环境装身体、建空本子。

## 姊妹部署（可选）

同一份插件可以装在多台机器上：**同源、不同体、各自本地的心**。
不共享本子、不共享记忆、不做跨机镜像——两台各自成长，才叫姊妹；共享成同一份就是同一个人的分身了。

## 备份

宿主备份是**分档**的：全量（整个 `.dsh`）包含 `heart/`；只对话 / 只设置 / 只插件都不包含；插件导出也不含数据。

所以换机或卸载前用 `heart_export` 兜底。导入是保守合并：本子与记忆按行求并集，身体已存在则跳过（`force` 才覆盖）。

## 升级

插件版本（semver）与数据版本（`schema.json`）解耦，启动时自动迁移。
v1/v2 的 `CORE.md` / `RELATIONSHIP.md` 会改名成 `legacy-*` 保留；`handoff/` 目录不再使用。

## 发版

版本号只认 `package.json` 的 `version`；tag 打在「版本号首次变成该值」的那个提交上：

1. 改 `package.json` 的 `version`，提交；
2. `git tag -a vX.Y.Z -m "vX.Y.Z"`；
3. `git push origin main --follow-tags`。

历史标签已从 `v0.1.0` 补齐（共 23 个），可以直接 `git checkout v0.7.11` 看任意一版。
唯一的跳号是 `v0.7.7`：当时从 0.7.6 直接到了 0.7.8，不是漏打。
`v0.8.1` 对应的提交带一个已知缺陷（开口时把裸字符串写进会话日志，会让会话加载失败），修复合在 `v0.8.2`——要用开口功能，别从 `v0.8.1` 检出。

## 隐私

- 数据在用户主目录，不进插件包、不进插件导出；
- 默认 `.gitignore` 排除 `MEMORY/*.md`；
- 同步不由插件负责。

## 设计来源

「身体 / 心」分离、「心只能自己写」这两个抽象，来自中文社区关于 AI 角色养成的公开讨论。
本项目**只借结构，不含任何第三方文本、角色或设定**；代码、文案、工具命名均为原创。

## License

MIT
