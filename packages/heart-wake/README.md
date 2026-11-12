# dsh-heart-wake

小满 / DSHA 独立自唤醒套件（Cordis 插件，版本 `0.1.0`）。提供 `heart_wake` 工具，支持伴侣在有明确关怀或提醒事项时主动拉起新的会话回合，且受三道刚性防自激门禁保护。

## 核心职责与边界

- **独立于 Heart 本体**：作为外挂独立套件运行，不修改 `@dsh/heart` 状态机或记忆库，通过可选协议联动 `ctx.heart.evaluateActivity()`。
- **协议契约安全**：`agent.followup()` 必须接收完整的 `UserMessage` 结构体对象（包含 `id`, `role: 'user'`, `content: [{type: 'text', text}]`, `source: { kind: 'schedule' }`），严禁传原始字符串破坏宿主会话日志。
- **执行目标路由**：优先使用 `exec.agent`；若无则自动匹配当前正在运行该回合的 agent 会话，或取最近空闲会话。

## 三道刚性门禁 (Safety Gates)

1. **回合与自激防范闸 (Turn & Loop Lock)**：
   - 同一会话同轮次重复调用拒绝。
   - 距上次唤醒不足 15 秒强制冷却。
   - 由自唤醒触发的回合通过上下文回溯标记，严禁在自唤醒回合中再次自唤醒（杜绝无限自激循环）。
2. **作息时间闸 (Quiet Hours Gate)**：
   - 严格基于 Asia/Shanghai 时区，每日 01:00 至 07:00（含 01:00，不含 07:00）静默保护。
3. **频次与配额账本 (Ledger & Quotas Gate)**：
   - 使用 Node.js 24 原生 `node:sqlite`（`DatabaseSync`）持久化至 `/root/.dsh/heart-wake/wake.sqlite`。
   - 事务级锁（`PRAGMA synchronous = FULL; BEGIN IMMEDIATE;`），防跨进程并发穿透。
   - 滚动 1 小时最多 2 次；上海自然日最多 6 次。
   - 防系统时钟倒拨检测（`clock_regressed`）。

## 工具契约

- **名称**：`heart_wake`
- **参数**：
  - `reason` (string, 必需)：唤醒缘由，简述需要主动唤醒的事情（1-120 字符）。
  - `message` (string, 必需)：注入后续会话的开场消息文本（1-500 字符）。
- **返回值**：
  - `ok: true, turnId, scheduledAt, reason`（成功）
  - `ok: false, code, message`（被门禁拦截或失败）

## 自动化测试

运行本套件单元测试：
```bash
node --test test/wake.test.js
```
包含 10 项端到端及安全边界测试（门禁拦截、并发竞争、账本回滚、异常输入防御等）。
