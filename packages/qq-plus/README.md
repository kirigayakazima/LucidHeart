# @dsh/qq-plus (QQ 机器人增强插件)

> **源码候选版本**: `0.3.0`（手机验收另记）
> **所属架构**: DSHA Sovereign Plugin Ecosystem  
> **协议绑定**: Heart Protocol v1 & Cordis Microkernel

QQ 机器人的双向交互与拟人化增强插件：
1. **入站唤醒门控（Wake Gate）**：替代官方硬编码的 `@bot` 限制，支持以名字唤醒（小满 / 阿醒），并向 Heart 上报感知。
2. **出站拟人化打字（Cadence Split）**：在发送前将长消息切分成 2~4 条短气泡，带有打字停顿延迟，并依据 Heart 情绪与精力状态动态微调。
3. **同包异态（One Package, Dual Persona）**：同一套代码自动识别宿主环境，在手机端自动激活**小满（妹妹）**画像，在 PC 端自动激活**阿醒（姐姐）**画像。
5. **引用回复透传与分段防刷屏 (Message Reference & Deduplication)**：与底层 `@tencent-connect/dsh-qqbot` 联动，长回答切分成多段时**仅第 1 段携带 QQ 引用回复框**，后续分段自动设置 `quoteReply: false`，杜绝重复引用卡片刷屏；`shouldSplit` 识别非 keyboard 选项，保证带引用选项的消息正常拟人切分。
4. **可选Heart接线**：通过 `ctx.get('heart')` 动态读取服务，支持迟到/重载；不会靠吞掉未声明属性异常假装已经联动。`conversationDiagnostics()`可查看实际服务与发送路径计数。

0.3.0新增：默认 `deliveryMode: semantic` 将宿主流式更新缓存在本地，完整回复按语义段落投递，不是边生成边发气泡。`native-stream` 可显式保留原生QQ流式。`semanticParagraphs: true` 保留短回复的明确空行。新QQ驱动0.5.7传入回合取消信号，停止/下一已接受回合/卸载会取消尚未发送的气泡；已发送内容无法撤回。每目标有序、跨目标独立，部分发送错误向上传播。

---

## 角色画像预设

| 属性 | 小满（妹妹·常驻红米手机） | 阿醒（姐姐·Windows PC） |
|---|---|---|
| **身份 ID** | `xiaoman` | `axing` |
| **群唤醒词** | `小满`、`妹妹`、`满宝`、`小满同学` | `阿醒`、`姐姐`、`醒醒`、`醒宝` |
| **打字断句阈值** | `100` 字符 | `140` 字符 |
| **单段目标长度** | `60` 字符 | `90` 字符 |
| **气泡发送延迟** | `600ms`（灵动短促） | `1000ms`（从容温和） |
| **Heart 情绪联动** | 兴奋时快打短句，疲惫时从简 | 疲惫时精炼回复，从容稳定 |

---

## 判定层级（四层级联）

1. **显式配置**：`config.persona = 'xiaoman' | 'axing'`；
2. **Heart 契约快照**：读取 `ctx.heart.getSnapshot().device`（`phone` 或 `win`）；
3. **宿主特征探测**：检查 Android 容器 bridge 凭证与系统平台；
4. **动态微调文件**：读取 `~/.dsh/qq-plus.json`（支持实时热更新，无需重启）。

---

## 测试

```bash
node --test test/*.test.js test/*.test.mjs
```
测试结果按当次实际日志记录；历史测试数量不表示本次代码、手机自然度或所有场景持续通过。
