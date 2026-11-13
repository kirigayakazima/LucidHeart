# dsh-evolution 0.1.0

Suite 0.7.0 的独立 Cordis 插件。小满默认用 `/root/.dsh/evolution/`，阿醒默认用自己的 `~/.dsh/evolution/`。Node.js 24 原生 SQLite 持久化协作、成长与评测三库。插件通过 Heart 服务门控和回流，通过 Memory、Companion 服务只读取证。

| 模块 | 入口 |
| --- | --- |
| 姐妹协作 | `sister_send`、`sister_receive`、`sister_mark_handled`、`sister_retry` |
| 成长足迹 | `growth_record_footprint`、`growth_generate_digest` |
| 共同经历 | `companion_resonance_find`，每会话一小时最多一次 |
| 场景隐私 | `surface_bridge_filter`、`surface_bridge_cue`、`surface_bridge_record` |
| 模型评测 | `evolution_model_compare`，写入 JSON 和 Markdown 对照报告 |
| 场景回放 | `node --test packages/evolution/test/regression_replay.test.js` |

## 协作与可见性

在双方宿主配置各自角色 `role: "axing" | "xiaoman"`、可信的 `ownerDirectSessions`、`coreGroupSessions` 和对端 `sisterUrl`。协作 URL 以 `/api/dsh-evolution/sister` 结尾，使用 HTTPS 或 ADB 转发的回环 HTTP。双方通过环境变量 `DSH_EVOLUTION_SISTER_SECRET` 配置同一份至少 32 字符的独立密钥。用户在本人私聊以 `发给姐妹：<摘要>` 确认后，工具才能发出。收件箱以消息 UUID 去重，消息有效期 24 小时。协作包作为建议由收件方处理，不会触发后台工具执行。

群聊只读取已登记且标为 `PUBLIC_FRIENDLY` 的条目。可见性取自 SQLite，目标场景取自当前宿主消息。核心主群用户可用 `公开话题：<主题>` 登记短期承接提示，或用 `公开记录：<引文>` 登记公开足迹。成曲足迹需要任务证据和本轮用户确认已听过。既有私聊或其他插件中的记忆仍由原插件管理。

## 评测

回放 fixture 包括可执行宿主场景和带固定参考输出的模型场景。实际模型对比导入同一批 `adapter: "model"` 场景样本。每个模型提供 `name`、`samples` 与可选的 `pricePerMillion: { prompt, completion }`（人民币）。样本使用 `{ scenarioId, output: { text, toolCalls }, ttftMs, totalMs, promptTokens, completionTokens }`。未提供价格时成本留空。

运行 `pnpm --filter dsh-evolution test` 执行单元与回放测试。
