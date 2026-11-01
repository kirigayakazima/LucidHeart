# Heart 0.19.0 × Mnemon 集成实施结果

2026-10-30。开发分支 `codex/heart-external-memory`。**代码和隔离验收完成；生产仍是原配置，没有部署或启用 external。**

## 改动

| 文件 | 改动 |
|---|---|
| `lib/store.js` | canonical `config.json.memoryMode`，默认 legacy；存储层拒绝 external 的 fact/MEMORY 修订、删除和新增，跳过旧档案迁移；封闭整包导入、导出覆盖档案和配置的旁路；旧查询标明来源 |
| `lib/index.js` | 模式匹配的工具说明；self 默认仅 Notebook，显式 includeLegacy 才返回旧 facts/MEMORY；Dream 新增 selfPrinciple 声明 |
| `lib/prompt.js` | external 不自动注入旧 facts，继续注入自我原则、Voice、Mood |
| `lib/dream.js` | 拒绝事实晋升；保留沟通观察 → Voice，Notebook 需人工确认并显式 selfPrinciple=true；保留 preview/commit 和现有锁 |
| `bin/heart.js` | `mode legacy/external` 查看/切换，CLI 与工具共用存储保护；`self --legacy` 读取旧档案 |
| `test/external-memory.test.js` | 新增 7 项边界测试（每项含多个入口断言） |
| `package.json`、README、CHANGELOG | 版本 0.19.0，操作说明及限制 |

没有增加模型工具名，没有引入 Mnemon 私有 Provider/CLI 调用或 Memory Adapter。Notebook 是自我原则，不能用来绕过用户事实停写；此边界依赖调用语义与人工声明，不做新的正文语义分类引擎。

external 下整包导入全部拒绝，包括仅含自我层的整包和 force，以避免任意文件名/配置覆盖旁路。恢复可先在隔离副本中进行；未实现新的部分导入框架。

## 自动化和真实宿主验收

- 全量 **151/151** 测试通过（原 144 项＋新增 7 项）；`git diff --check` 通过。
- 新边界覆盖默认 legacy、回退、fact/MEMORY API、CLI、revise/discard、大小写 kind/target、导入 force/配置覆盖/路径别名、导出覆盖及链接目录、启动迁移、只读来源标记、Dream、坏配置保守停写。
- Body/Sense/Trigger/pulse 的 external 状态读写测试通过；这不等于红米硬件采样验收。
- 真实 DSH 0.2.1-rc.2 每次启动，在实际工具注册表执行七种拒写探针，同时验证 Notebook 写/改/弃、Voice、Mood 和旧档案读取。工具拒绝和档案不变检查通过。
- 模式仅存于 Heart 根的 config.json；不接受 profile 同名字段作为第二个权威配置。工具说明在宿主启动时生成，切换后需重载；存储保护即时读取 canonical 模式。坏配置不重新开放通用记忆写入。

真实模型沿用 Sensenova `sensenova-6.8-flash-lite`，Mnemon 固定 commit `7cbdefc64c019a073cfdb493b0b516b5b7177bb6`，Native Provider 0.5.10 / CLI 0.2.13。仅一个新建的 `acceptance-shared` Space；Runtime、Documents、Skills、Active Capture 等不需要来源/实验功能关闭，没有跨设备或 Git 同步，没有接入外部记忆服务。

| 场景 | 结果 |
|---|---|
| A 明确要求记住紫色 | 正式 Mnemon 任务 Agent 提交到共享 Space；第一次误调用已停用 Runtime 被拒绝后恢复，无 Heart 事实写入 |
| 独立 B 召回 | 从同一 Space 返回紫色；首次模型请求不包含答案 |
| B 明确更新为绿色 | 正式 forget＋remember 完成；紫色记录保留为软删除历史 |
| 独立 C | 只召回并回答绿色；首次请求没有颜色答案 |
| 停止宿主后新进程 D | 仍召回绿色；没有复制数据库或复用 A 的上下文 |
| 旧 Heart 兼容 | 有独立旧事实/事件标识，既未被自动注入，也未写入当前颜色；facts/MEMORY 与验收前逐字节一致 |
| 模式回退 | 停止宿主后 external → legacy → external；整个 Mnemon 文件树的 SHA-256 清单不变，不需要重建/删除数据库 |

最终 Heart Notebook/Voice 中没有紫色或绿色，只有自我原则和沟通习惯；旧档案标识也未出现在实际模型首次请求中。Mnemon 保留一条有效绿色和一条已软删除紫色。这证明本轮隔离配置没有重复保存或自动注入当前用户事实，不能推断任意生产历史 Notebook 已经纯净。

## token 成本与有限优化

原验收只把两个 Heart 工具暴露给模型。本轮为验证兼容入口，真实暴露 Heart 全部 18 个工具，故实际工具数从 40 增为 **56**；不是此次新增了 16 个 Heart 工具。Mnemon 全局工具仍为 17 个。

| 正常集成场景 | 请求数 | 输入 token（含缓存） | 其中缓存 | 输出 token | 耗时 |
|---|---:|---:|---:|---:|---:|
| A 写入 | 9 | 66,356 | 56,576 | 2,441 | 71.9 秒 |
| B 召回 | 3 | 22,847 | 10,752 | 445 | 19.0 秒 |
| B 更新 | 10 | 71,032 | 56,064 | 4,212 | 117.0 秒 |
| C 召回 | 3 | 22,674 | 18,944 | 253 | 12.3 秒 |
| D 重启召回 | 3 | 22,736 | 21,760 | 672 | 12.4 秒 |
| **合计** | **28** | **205,645** | **164,096** | **8,023** | **232.6 秒** |

主对话 13 次、记忆任务 Agent 11 次、标题 4 次。输出包含供应商计入的推理 tokens。相比上一轮的 29 次不能归因于配置优化：模型选择、缓存和可见工具集均有差异；**没有获得可靠的整体降本/提速结论**。未取得供应商账单，不推算人民币实扣。

本轮首次 prompt 为 **11,007 tokens**（读请求），之前部分 Heart 工具配置为 8,993。差额主要涉及恢复 Heart 兼容工具及自我层内容，不能归为 Mnemon 新增记忆正文。

对之前新增 3,695 prompt token 的拆解，保留真实供应商总差；局部使用 cl100k_base 估算，不能当成供应商可相加账单：

| 部分 | 字符数 | cl100k 估计 tokens |
|---|---:|---:|
| 17 个 Mnemon 新工具 schema | 15,657 | 3,075 |
| 新系统指导段 | 291 | 58 |
| 动态路由/工具指引 | 491 | 112 |
| 首次请求的具体 Space ID/记忆正文 | 未出现 | 不作为常驻正文计入 |

实际目录细节在 `mnemon_memory_bodies` 的工具结果中按需返回。工具 schema 是主要固定负担，不能仅用常驻正文预算解释这 3,695 tokens。

官方配置的调查/尝试：

- `taskAgentModel=fixed`：使用本机已配置的 `sensenova-u1-fast`，实际返回 404。记录失败后恢复官方 inherit，未继续寻找其他模型、未改调度系统。
- `routingGuidance=false`：实际召回通过，工具数仍 56，首次 prompt **11,007 → 10,947**，仅省 60 tokens（约 0.55%）；没有实质收益，最终恢复 true。
- Scoped 只限制 Source 顺序/可写范围；本轮已只有一个活跃 Memory Space Source，不等于删除全局工具 schema。Light Context 只限制 resident projection，不能减少这些工具定义。源码核对后未为此启用更多扩展，也不宣称已测得它们的成本收益。

优化失败探测及 guidance 对照另外产生 11 次请求尝试（其中 2 次 404、无 usage）。整轮实施合计 39 次尝试，返回 usage 的输入共 289,238、其中缓存 211,200、输出 11,262 token。这些不与核心 28 次混算为功能通过。

## 已知限制

- Runtime 已停用，但通用 `mnemon_runtime_memory` schema 仍被官方注册；模型在 A 中误调一次并收到 not offered，再改走 Space。这是固定负担和失败重试来源之一，本轮未改 Mnemon 的工具系统。
- 事实更新是 forget＋remember 两个动作，不是事务。隐含变化、并发、多事实压力及长期可靠性未测。
- embedding 明确关闭。模型回复中“服务没响应/以后自动补齐”的说法不能视作已验证行为；本轮只验收关键词/时序召回，没有启用自动向量补齐。
- Notebook 的旧内容可能混有用户事实，生产切换前要人工核对；本轮不自动分类或改写旧 Notebook。Dream Notebook 晋升依赖人工 selfPrinciple 声明，不是内容安全分类器。
- 保护范围是当前版本的 Heart 自身入口，不是操作系统只读权限。旧版 Heart 或外部文件写入者不会遵守新模式。
- 未做生产 Desktop/Web UI、红米、跨工作区、自动捕获、跨设备同步或旧事实迁入 Mnemon 的验收。

## 生产切换/回退步骤（未执行）

**⚠️ 以下涉及生产停机、安装及配置修改，需另行授权；本轮到此停止。**

1. 备份 Heart 和 Mnemon，停止所有指向同一 Heart 根的写入者。先在实际生产 profile 的隔离副本验收 Mnemon 和共享 Space。
2. 将所有写入者升级到已审阅的 Heart 0.19.0，固定包与 lockfile；不能只给仍运行 0.18.1 的目录写 external 标志，旧版会忽略它。
3. 核对旧 Notebook 只承担自我原则后，设置 `HEART_ROOT` 为经过确认的数据根，运行已审阅 CLI 的 `mode external`，再启动宿主检查工具说明、提示词及拒写。
4. 回退时停止宿主，运行同一 CLI 的 `mode legacy`，同时停用 Mnemon 的模型写入来源，避免双写；重启。Mnemon 数据保留原处，无需修改、重建或删除。

## 证据与复现

测试/配置代码位于工作区 `projects/memory-provider-validation`：`heart-integration-prepare.mjs`、`heart-integration-observer.mjs`、`heart-integration-continue.mjs`、`heart-integration-check.mjs`、`heart-integration-run.mjs`。观察器的直接工具探针与自然语言模型测试分开记录，不拿探针冒充真实 Agent 调用。

在该目录执行 `node heart-integration-run.mjs --run` 可在全新隔离目录重复 A/B/更新/C/D 及 routingGuidance 对照，会产生真实模型用量；依赖现有可用模型配置及固定 Mnemon 源码。默认不尝试已确认 404 的快速模型。

证据位于 `projects/memory-provider-validation/evidence/heart-integration/`：`summary.json`、各轮去除 thinking 的 `.trace.jsonl`、`integration-checks.json`、`native-records.json`、`heart-host-contract.json`、`prompt-breakdown.json`、`heart-test-results.txt`、实际 profile 配置。导出检查未发现密钥值。

所有隔离宿主和录制代理已退出，生产 profile 没有变更。
