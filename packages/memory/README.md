# @dsh/memory

本地源码0.1.1。Core独立于DSH，适配器提供memory_remember、memory_recall、memory_inspect和memory服务。手机实际加载证据见[工作区STATUS](../../../../docs/STATUS.md)，不能按package.json推断。

## 当前存储和接口

选定dataDir的journal.jsonl是变更回放依据；SQLite/FTS和facts.md为派生投影。MemoryService构造会建目录、回放和可能写派生视图，不是只读调查入口。episodes有写入方法，但当前remember不自动调用，不代表已建生活日记。

Core提供remember/recall/inspect/correct/revoke/reindex/close；模型工具只开放上述三个入口。recall默认返回有估算Token预算的紧凑骨架，再按需inspect。估算值不是Provider实际计费。

0.1.1模型recall使用配置scope，inspect隐藏其他角色和非active条目；Core inspect保留管理审计语义。配置scope优先，默认Windows为axing_private，其余为xiaoman_private。shared仍需后续audience细分，不能当公开许可。

## 已知边界

适配器remember仍默认confidence1/confirmedtrue且未取得实际exec来源。journal回放跳过坏行、correct分次追加、空回放可能残留旧索引；有效时间和派生撤销传播需继续完善。不能声称断电无损、每次重建100%可靠、已有人类遗忘或自动生产评分。

当前默认排序为FTS rank/confidence/created_at。Memory Shape是独立只读展示，影子分数不改变检索。两目录存在不意味着同时召回；dataDir是唯一选定权威，不自动合并。

源码含合成用例，但没有可比对的Mnemon现场基线和固定规模性能证据，因此不保留旧82%/100%、180ms/1.2ms等营销式对比。[下一版设计](../../../../docs/roadmap/NEXT-VERSION-DESIGN.md)覆盖来源、提交可靠性、纠错/撤销与旁路比较，尚未实现。

运行本地回归：`node --test test/*.test.js`，使用支持node:sqlite/FTS5的Node（手机已确认Node24）。新增工具必须通过实际SDK参数/返回schema验证，不能仅直接调用execute。

MIT。
