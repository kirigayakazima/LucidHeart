# @dsh/memory

Core 独立于 DSH，适配器提供 `memory_intake`、`memory_remember`、`memory_recall`、`memory_inspect`、`memory_correct`、`memory_forget` 和 memory 服务。手机实际加载证据见[工作区 STATUS](../../../../docs/STATUS.md)。

## 当前存储和接口

选定dataDir的journal.jsonl是变更回放依据；SQLite/FTS和facts.md为派生投影。MemoryService构造会建目录、回放和可能写派生视图，不是只读调查入口。episodes有写入方法，但当前remember不自动调用，不代表已建生活日记。

Core 提供 remember/recall/inspect/correct/revoke/reindex/close。recall 默认返回有估算 Token 预算的紧凑骨架，再按需 inspect。模型通过自然对话决定何时纠错或注销，群聊和私聊共享同一份 journal。

模型 recall 使用配置 scope，inspect、correct 和 forget 仅定位当前角色可见的 active 条目。Core inspect 保留管理审计语义。配置 scope 优先，默认 Windows 为 axing_private，其余为 xiaoman_private。

## 已知边界

新摄取记录从 DSH 当前回合与工具调用定位消息，通过 QQ 驱动的偏移提取当前发言。可逐字核对或只需替换主语的第一人称陈述会标记为 `user_statement` 并确认。无法核对的改写、模型推断和缺少出处的记录进入候选。日志只存有界证据片段和消息引用，旧条目在重放时保留原始字段与确认状态。

`correct` 的证据字段取自模型提交的事实陈述。纠错与自动覆盖使用单条 `supersede` Mutation，`replaces`、新条目和校验摘要一起追加，文件刷盘后才更新投影。新版 reader 兼容旧的双行和单行覆盖。坏行、截断或校验失败会关闭读取与写入，等待完整回放。原始 journal 保留作审计；FTS 和 Markdown 仍为派生数据。若刷盘已成功但投影更新失败，错误带 `durable: true` 和 `projection: 'degraded'`，重放可恢复已提交的纠错。

会话骨架按 FTS 相关度选取最多三条完整事实，用包括包装在内的 200 UTF-8 字节作为 Token 保守上限。`retrievalPolicy` 默认 `fts`。选用 `shadow` 时，异步对同范围的 FTS 候选重排，将条目 ID、分项分数及耗时写入 `shadow-retrieval.jsonl`。两种模式返回同一份基线结果和提示词。dataDir 仍是单写者使用的唯一选定权威。

[下一版设计](../../../../docs/roadmap/NEXT-VERSION-DESIGN.md)记录来源、提交可靠性、纠错与旁路比较的整体范围。当前本地验收覆盖来源契约、宿主取证和旧条目回放。

运行本地回归：`node --test test/*.test.js`，使用支持node:sqlite/FTS5的Node（手机已确认Node24）。新增工具必须通过实际SDK参数/返回schema验证，不能仅直接调用execute。

MIT。
