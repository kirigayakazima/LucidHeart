# dsh-companion 0.1.0

独立 Cordis 插件。安装包通过 `cordis.patch.yml` 注册，宿主需要提供 `tools`。手机默认使用 `/root/.dsh/companion/`，测试可通过 `dataDir` 指向独立目录。Node.js 24 原生 `DatabaseSync` 持久化活动、曲库、项目、关怀与成长、任务五个数据库。

| 模块 | 工具（均带 `companion_` 前缀） | 行为 |
| --- | --- | --- |
| 活动 | `activity_start/step/pause/resume/finish/abort` | 每个会话一个活跃活动，开始和结束回流 Heart |
| 游戏 | `activity_start`、`game_action` | 以 `type: "game"` 开局。二十问使用 `initial_state: { game: "twenty_questions", target_category, target_hash, salt }`。也可传 `target` 由插件计算承诺。接龙使用 `{ game: "idiom_chain", current_word, allow_homophones }` |
| 点歌 | `jukebox_list/add/next/history` | 调用现有 `rvc_sing`，复用其 FullAwake 分流、手机回退与 QQ 投递。查询或切歌时按 RVC 产物核对任务，`next` 确认上一首并启动下一首 |
| 小项目 | `project_create/checkin/status` | 跨日打卡，里程碑和打卡记录同事务提交 |
| 关怀与兴趣 | `care_evaluate`、`care_commitment_add/complete`、`interest_record` | 按宿主实际用户消息计算 4 小时回归间隔，上海自然日最多两条关怀建议。兴趣按独立消息累计，三次且热情分达到 4 才建议晋升 |
| 成长 | `growth_observe/promote/list` | 只接受与候选绑定的真实用户确认，或 7 天内三条独立正向强化。晋升写 Companion 配置和只追加的 SHA-256 审计链 |
| 任务 | `task_create/update/get` | 会话归属、幂等键、单调进度、终态约束。宿主重载时将已超时的运行中任务标为 `host_restarted` |

二十问的承诺是 `SHA256(JSON.stringify([salt, target.trim().normalize('NFKC').toLowerCase()]))`，`salt` 至少 128 位。题目需要对猜题方保密时，定题方在工具外计算哈希，只传承诺和盐。工具调用本身可能被宿主记录。二十问以 `ask → answer` 推进，答完第 20 问后使用 `reveal` 校验。成语接龙用 `answer` 出词，支持 `hint` 和 `surrender`，词汇校验覆盖内置常用成语。

关怀以真实消息和本地记录为准。Memory 现有约定经公开服务只读参考，完成确认保存在 Companion。成长配置可由 `growth_list` 查询，核心 Notebook 与 Memory 保持原有权威。点歌历史返回本会话的成曲路径，可用于现有 QQ 附件投递。

在 Monorepo 中运行 `pnpm --filter dsh-companion test`。
