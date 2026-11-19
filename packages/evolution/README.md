# dsh-evolution 0.2.0

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

## 技能沙箱

`skill_propose` 登记候选版本。`skill_preview` 仅在已配置的本人私聊、触发语匹配且 Heart 放行时展示回复与步骤。步骤以文本保存。文本技能的 40 场景检查验证触发时的真实候选输出与非触发时的隔离性，不使用参考答案代替候选执行结果。

回放全通过后，用户可在本人私聊发送 `确认启用技能 <ID> 第 <版本> 版`，再由 `skill_commit` 切换启用版本。`skill_use` 读取已启用版本。发送 `回退技能 <ID>` 可由 `skill_revert` 撤销待试版本或将当前版本切回上一版，也可指定 `第 <版本> 版`。版本历史和切换指针保存在独立的 `skills.sqlite`。

`skill_learn` 从 1–3 条资源规则示范提取隔离的声明式策略参数。适用条件为 `ruleFamily: reserve`；规则未知、成本未知、受阻或资源不足时求助。`skill_decide` 仅使用已启用策略，返回建议，不执行外部动作。`skill_learning_plan` 从 Heart 最近核验的能力缺口生成最多三步、三次试验的学习计划，外部操作与 LLM Token 预算均为零。

`fixtures/skills/dev.json` 为可见开发集，`heldout.json` 为 48 场景冻结保留集，`freeze.json` 保存 SHA-256。策略执行面仅为声明式解释器，没有代码执行、文件访问或答案输入。评分器独立读取冻结答案，分别报告 naturalness/reliability/generalization，不产生总分。naturalness 仅是有界文本规则代理指标，未测量真实人类听感。对照基线为固定成本策略，检验的是资源成本规则的有限迁移，不能据此宣称通用泛化。

资源策略的冻结集前后分数、哈希和零回归证据持久化至候选评估。仅已启用且实测改善、零回归的版本进入本人月度手账；回退后不再展示。改变的是策略参数，未修改模型权重。

`joint_task` 协作包携带三方 participants、informed、authorizedBy、responsible、action、consentMessageId。发送端只能承诺自己负责的动作，不能替另一端确认知情或授权；对端收到签名包仍不会自动执行。历史非任务协作包保持兼容。
