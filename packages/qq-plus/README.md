# @dsh/qq-plus (QQ 机器人增强插件)

> **当前版本**: `0.2.1`  
> **所属架构**: DSHA Sovereign Plugin Ecosystem  
> **协议绑定**: Heart Protocol v1 & Cordis Microkernel

QQ 机器人的双向交互与拟人化增强插件：
1. **入站唤醒门控（Wake Gate）**：替代官方硬编码的 `@bot` 限制，支持以名字唤醒（小满 / 阿醒），并向 Heart 上报感知。
2. **出站拟人化打字（Cadence Split）**：在发送前将长消息切分成 2~4 条短气泡，带有打字停顿延迟，并依据 Heart 情绪与精力状态动态微调。
3. **同包异态（One Package, Dual Persona）**：同一套代码自动识别宿主环境，在手机端自动激活**小满（妹妹）**画像，在 PC 端自动激活**阿醒（姐姐）**画像。
4. **Cordis 安全探针防线 (Safe Optional Heart Access)**：针对 Cordis Context Proxy 的属性拦截机制进行了全面加固，所有对 `ctx.heart` 的访问均经由安全探针（`try...catch`），杜绝因未声明 inject 引发 `cannot get property "heart" without inject` 错误导致出站截断。

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
所有 31 项单元测试持续 100% 通过。
