# @dsh/memory

本地源码 0.1.1。Core 独立于 DSH，适配器提供 `memory_remember`、`memory_recall`、`memory_inspect`、`memory_correct`、`memory_forget` 和 memory 服务。手机实际加载证据见[工作区 STATUS](../../../../docs/STATUS.md)。

## 当前存储和接口

选定dataDir的journal.jsonl是变更回放依据；SQLite/FTS和facts.md为派生投影。MemoryService构造会建目录、回放和可能写派生视图，不是只读调查入口。episodes有写入方法，但当前remember不自动调用，不代表已建生活日记。

Core 提供 remember/recall/inspect/correct/revoke/reindex/close。recall 默认返回有估算 Token 预算的紧凑骨架，再按需 inspect。模型通过自然对话决定何时纠错或注销，群聊和私聊共享同一份 journal。

模型 recall 使用配置 scope，inspect、correct 和 forget 仅定位当前角色可见的 active 条目。Core inspect 保留管理审计语义。配置 scope 优先，默认 Windows 为 axing_private，其余为 xiaoman_private。

## 已知边界

适配器 remember 仍默认 confidence 1 和 confirmed true。correct 的证据字段取自模型提交的事实陈述。journal 回放跳过坏行，兼容旧的双行覆盖和新的单行覆盖事件。覆盖与撤销后，派生 FTS 和 Markdown 只展示活跃条目。原始正文留在 journal 供审计。

当前默认排序为FTS rank/confidence/created_at。Memory Shape是独立只读展示，影子分数不改变检索。两目录存在不意味着同时召回；dataDir是唯一选定权威，不自动合并。

源码含合成用例，但没有可比对的Mnemon现场基线和固定规模性能证据，因此不保留旧82%/100%、180ms/1.2ms等营销式对比。[下一版设计](../../../../docs/roadmap/NEXT-VERSION-DESIGN.md)覆盖来源、提交可靠性、纠错/撤销与旁路比较，尚未实现。

运行本地回归：`node --test test/*.test.js`，使用支持node:sqlite/FTS5的Node（手机已确认Node24）。新增工具必须通过实际SDK参数/返回schema验证，不能仅直接调用execute。

MIT。
