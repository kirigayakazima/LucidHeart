# @dsh/memory

Core 独立于 DSH，适配器提供 `memory_intake`、`memory_remember`、`memory_recall`、`memory_inspect`、`memory_correct`、`memory_forget` 和 memory 服务。手机实际加载证据见[工作区 STATUS](../../../../docs/STATUS.md)。

0.1.9 增加 `memory_album_revise`，以单条带目标 ID、递增 revision、reason 和更新描述的追加事件修订独立 `album.jsonl`，旧无 op 记录作为 create 兼容回放。坏行、跳号和不存在目标安全拒绝，来源哈希不变。修订工具绑定真实用户消息，不改事实 journal。

事实支持可选 `validUntil`、`freshness`、`audience`。到期状态只在检索/投影时计算，当前召回排除过期事实，服务端显式 `includeExpired` 查询会标记为历史。群聊只把匹配 targetId 与已知 participants 的条目用作共同知识；本人私聊仍读同一生活经历库。无新字段的历史事实保持原样，不自动写回元数据。

## 当前存储和接口

选定dataDir的journal.jsonl是变更回放依据；SQLite/FTS和facts.md为派生投影。MemoryService构造会建目录、回放和可能写派生视图，不是只读调查入口。episodes有写入方法，但当前remember不自动调用，不代表已建生活日记。

Core 提供 remember/recall/inspect/correct/revoke/reindex/close。recall 默认返回有估算 Token 预算的紧凑骨架，再按需 inspect。模型通过自然对话决定何时纠错或注销，群聊和私聊共享同一份 journal。

模型 recall 使用配置 scope，inspect、correct 和 forget 仅定位当前角色可见的 active 条目。Core inspect 保留管理审计语义。配置 scope 优先，默认 Windows 为 axing_private，其余为 xiaoman_private。

## 已知边界

`memory_album_save` 由模型在共同视觉经历值得纪念时调用，`memory_album_search` 按关键词、标签和时间检索。相册只追加到配置 dataDir 下的 `album.jsonl`，手机生产配置对应 `/root/.dsh/profiles/memory/album.jsonl`。来源哈希使用原媒体或 FullAwake 返回的截图 SHA-256，用户原话由宿主核验，记录包含消息出处。相同媒体和类型重复保存返回既有条目。私聊与主群共用该相册。

`memory.handoff.saveCall` 接收当前宿主会话与通话起始位置，在挂断时保存最近三轮真实对话。交接线索通过下一轮用户消息注入，QQ 原话偏移同步更新。

新摄取记录从 DSH 当前回合与工具调用定位消息，通过 QQ 驱动的偏移提取当前发言。可逐字核对或只需替换主语的第一人称陈述会标记为 `user_statement` 并确认。无法核对的改写、模型推断和缺少出处的记录进入候选。日志只存有界证据片段和消息引用，旧条目在重放时保留原始字段与确认状态。

`correct` 的证据字段取自模型提交的事实陈述。纠错与自动覆盖使用单条 `supersede` Mutation，`replaces`、新条目和校验摘要一起追加，文件刷盘后才更新投影。新版 reader 兼容旧的双行和单行覆盖。坏行、截断或校验失败会关闭读取与写入，等待完整回放。原始 journal 保留作审计；FTS 和 Markdown 仍为派生数据。若刷盘已成功但投影更新失败，错误带 `durable: true` 和 `projection: 'degraded'`，重放可恢复已提交的纠错。

会话骨架按 FTS 相关度选取最多三条完整事实，用包括包装在内的 200 UTF-8 字节作为 Token 保守上限。`retrievalPolicy` 默认 `fts`。选用 `shadow` 时，异步用相关度、时效、重要性、保留级别和 `mood:<state>` 标签重排同范围的 FTS 候选，将条目 ID、分项分数、耗时及 Jaccard@3 写入 `shadow-retrieval.jsonl`。在线倒数排名以 FTS 首位为参照，使用 `fts_top1_proxy` 标记。离线可将两组排序和标注的相关条目 ID 传给 `benchmarkRetrieval`，汇总 MRR@3。两种模式返回同一份基线结果和提示词。dataDir 仍是单写者使用的唯一选定权威。

当前已全面实装真实来源跟踪、原子提交可靠性（commit supersede）、自然纠错与 M7-05 影子重排对照，详见工作区 [STATUS](../../../../docs/STATUS.md)。当前本地验收覆盖来源契约、宿主取证和旧条目回放。

运行本地回归：`node --test test/*.test.js`，使用支持node:sqlite/FTS5的Node（手机已确认Node24）。新增工具必须通过实际SDK参数/返回schema验证，不能仅直接调用execute。

MIT。
