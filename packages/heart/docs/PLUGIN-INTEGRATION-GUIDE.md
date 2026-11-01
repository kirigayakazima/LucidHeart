# Heart 0.20.0 独立插件接入模板与开发指南

本文档指导外部独立器官插件（感知、表达、习惯、设备桥接）如何基于 **Heart Protocol v1** 与 Cordis 进行轻量、松耦合接入。

---

## 1. 核心接入原则

1. **松耦合与可选依赖**：
   - 外部插件各自独立维护 package.json、Git 仓库与发布周期。
   - 外部插件不要求直接源码依赖 `@dsh/heart`，可通过 Cordis 上下文中的 `ctx.get('heart')` 或 Cordis 依赖注入 `inject: ['heart']` 接入。
2. **三类交互的严格分离**：
   - **感知（Sensory）**：只能通过 `heart.observe(input)` 提交事实性观察。严禁直接修改三维情绪值（valence/arousal/energy）或直接改写 `mood.json`。
   - **表达/通知（Expression/Notification）**：监听 `ctx.on('heart/state-changed', (evt) => ...)` 获取最新状态快照。
   - **执行/输出（Execution/Actuation）**：如 RVC 语音合成、QQ 发送、PC 控制，由插件自身暴露服务或 DSH 工具，必须具有明确的 Promise 结果、超时与回退，严禁使用异步事件的 `consumed=true` 竞争。
3. **跨设备边界（PC Bridge / FullAwake）**：
   - PC Bridge 运行在 PC 端（如 FullAwake MCP 网关），手机端通过网络 Bridge/MCP 接入。
   - PC 在线时动态暴露能力，离线时及时下线能力。绝不把阿醒的数据与小满共享。

---

## 2. 插件接入模板

### 2.1 感知器官接入模板（例：`dsh-sticker-look`）

```javascript
// package.json 声明可选依赖
{
  "name": "dsh-sticker-look",
  "version": "1.0.0",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.0"
  }
}

// lib/index.js
export const name = 'dsh-sticker-look'

export function apply(ctx) {
  // 当识别到表情包或图像时向 Heart 提交感知
  async function reportSticker(stickerInfo) {
    const heart = ctx.get('heart')
    if (!heart) {
      // Heart 插件未安装或暂时不可用时的安全降级
      return { ok: false, reason: 'heart_service_unavailable' }
    }

    const observation = {
      type: 'sticker',
      source: 'sticker-look',
      confidence: stickerInfo.confidence || 0.85,
      evidence: {
        meaning: stickerInfo.meaning, // 如 "comfort", "hug", "funny"
        fileId: stickerInfo.id,
      },
      summary: `识别到表情包 [${stickerInfo.name}]：${stickerInfo.meaning}`,
    }

    // 调用 Heart 标准感知接口
    const result = await heart.observe(observation)
    return { ok: result.accepted, stateChanged: result.stateChanged }
  }

  // 注册或导出自身能力
  ctx.provide('stickerLook', { reportSticker })
}
```

---

### 2.2 表达器官接入模板（例：`dsh-actuator-voice`）

```javascript
export const name = 'dsh-actuator-voice'
// 声明可选监听 heart
export const inject = {
  optional: ['heart']
}

export function apply(ctx, config) {
  let currentMood = 'calm'

  // 1. 监听状态变更通知（生命周期受 Cordis Fiber 管理，卸载自动注销）
  ctx.on('heart/state-changed', (event) => {
    currentMood = event.current.mood.state
    console.log(`[Voice] 表达状态已切换至: ${currentMood} (原因: ${event.eventSource})`)
  })

  // 2. 导出可靠发声执行服务（明确结果与回退机制）
  ctx.provide('voiceActuator', {
    async speak(text, options = {}) {
      try {
        const mood = options.mood || currentMood
        // 调用本地/远程 RVC 或 TTS 服务
        const audioPath = await callRvcInference(text, mood, { timeoutMs: 5000 })
        return {
          ok: true,
          audioPath,
          usedMood: mood,
        }
      } catch (err) {
        // 明确报告失败，支持上层可靠回退到纯文本输出
        return {
          ok: false,
          fallback: 'text_only',
          error: String(err.message || err),
        }
      }
    }
  })
}
```

---

### 2.3 习惯与自主行为接入模板（例：`dsh-bili-scroll`）

```javascript
export const name = 'dsh-bili-scroll'

export function apply(ctx, config) {
  // 监听空闲通知
  ctx.on('heart/idle', async (idleEvent) => {
    const heart = ctx.get('heart')
    if (!heart) return

    // 1. 先向 Heart 询问当前状态是否适宜浏览 B 站
    const evaluation = heart.evaluateActivity({
      intent: 'browse_bilibili',
      category: 'bilibili',
      estimatedDurationMinutes: 15,
    })

    if (!evaluation.suitable) {
      console.log(`[BiliScroll] 当前不适合自主浏览：${evaluation.recommendation}`)
      return
    }

    // 2. 自行执行 B 站浏览行为
    try {
      const video = await fetchRecommendedVideo()
      console.log(`[BiliScroll] 自主浏览完成: ${video.title}`)
      
      // 3. 将行为结果作为事实观察汇报给 Heart
      await heart.observe({
        type: 'activity',
        source: 'bili-scroll',
        confidence: 0.9,
        evidence: { status: 'completed', videoId: video.bvid },
        summary: `看了视频《${video.title}》`,
      })
    } catch (err) {
      console.error('[BiliScroll] 执行异常:', err)
    }
  })
}
```

---

### 2.4 跨设备感官桥接接入规范（FullAwake / PC Bridge）

```javascript
// 手机 DSHA 侧 PC 能力接入器
export const name = 'dsh-pc-bridge-client'

export function apply(ctx, config) {
  let pcOnline = false

  // 轮询或基于 SSE 事件感知 PC 在线状态
  function updatePCStatus(status) {
    const wasOnline = pcOnline
    pcOnline = Boolean(status.online)

    if (pcOnline && !wasOnline) {
      console.log('[PC Bridge] PC 已上线，FullAwake MCP 视觉/文件工具已就绪')
      const heart = ctx.get('heart')
      if (heart) {
        heart.observe({
          type: 'sensor',
          source: 'fullawake',
          confidence: 1.0,
          evidence: { device: 'home-pc', screenLocked: status.screenLocked },
          summary: 'PC 终端已连通在线',
        })
      }
    } else if (!pcOnline && wasOnline) {
      console.log('[PC Bridge] PC 已关机离线，注销相关外部能力')
    }
  }
}
```
