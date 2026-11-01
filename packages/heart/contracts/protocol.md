# Heart Protocol v1 规范文档

## 1. 架构定位与核心原则

Heart Protocol v1 是为手机 DSHA 小满及周边独立插件定义的**最小微内核扩展协议**。

### 核心定位
- **唯一主脑**：手机 DSHA 是小满唯一的推理、记忆与人格中枢。
- **职责清晰**：
  - **DSH**：负责大模型、多轮会话、工具调用、基础权限。
  - **Heart Core**：负责状态维护（Mood 2.0）、自我认知、节律判断与公共扩展协议。
  - **Cordis**：负责同宿主进程内插件生命周期管理、依赖注入与事件发布。
  - **独立器官插件**：独立执行感知（Sensory）、表达（Expression）与行为（Habit/Actuator）。
  - **FullAwake / PC Bridge**：负责跨设备网络桥接，暴露受限 Windows 能力，绝不触碰阿醒数据。

### 三种交互边界
1. **感知（Observation）**：
   - 外部插件向 Heart 提交事实性观察（`heart.observe(input)`）。
   - **严格禁止**感知插件直接修改三维情绪值（valence/arousal/energy）或直接写入 Mood 存储。
   - Heart 内部依据置信度、事实证据与自身状态转移矩阵决定是否更新情绪底噪。
2. **通知（Notification）**：
   - Heart 在状态变更时发布 `heart/state-changed`，在空闲条件成立时发布 `heart/idle`。
   - 通知为单向广播，不等待异步执行结果，不强求所有监听器执行，不包含执行授权。
3. **执行（Execution）**：
   - 语音生成（RVC/TTS）、QQ 消息发送、Windows 键鼠文件操作均属于独立执行插件的职责。
   - 执行必须具备明确的 Promise 结果、超时、回退机制，严禁利用异步事件的 `consumed=true` 竞争。

---

## 2. 5 个最小公共接口契约

### 2.1 `heart.getSnapshot()` (Service)
获取 Heart 当前只读状态的外部视图。

- **返回格式**：
```typescript
interface HeartSnapshot {
  protocolVersion: "1.0.0";
  heartVersion: "0.20.0";
  timestamp: string; // ISO 8601
  device: string;
  memoryMode: "legacy" | "external";
  mood: {
    state: "calm" | "engaged" | "cheerful" | "excited" | "tired";
    intensity: number;
    reason: string;
    valence: number; // [-1.0, 1.0]
    arousal: number; // [0.0, 1.0]
    energy: number;  // [0.0, 1.0]
    why: string;
    updatedAt: string;
  };
  presence: {
    status: "present" | "away" | "asleep" | "unknown";
    lastSeenAt?: string;
  };
  idle: {
    date: string;
    totalUsed: number;
    totalCap: number;
    nextIdleAt: string | null;
    categories: Array<{
      id: string;
      label: string;
      used: number;
      dailyCap: number;
      remaining: number;
    }>;
  };
}
```

### 2.2 `heart.observe(input)` (Service)
接收经过校验的外部感知输入。

- **请求参数**：
```typescript
interface ObservationInput {
  type: string;        // "sticker" | "wake" | "vision" | "audio" | "sensor" | "activity" | "custom"
  source: string;      // "qq" | "fullawake" | "desktop" | "sticker-look" 等
  timestamp?: string | number; // ISO 字符串或毫秒时间戳（可选，缺省为当前时间）
  confidence: number;  // [0.0, 1.0]
  evidence?: Record<string, any> | string; // 证据载荷
  summary?: string;    // 可读摘要
}
```
- **安全约束**：
  - 严禁包含 `valence`、`arousal`、`energy`、`moodDelta`、`state`，否则请求被拒绝。
  - 置信度必须在 0.0 ~ 1.0 之间。
- **返回结果**：
```typescript
interface ObservationResult {
  accepted: boolean;
  observationId: string;
  stateChanged: boolean;
  actionTaken?: string;
  reason?: string;
  snapshot?: HeartSnapshot;
}
```

### 2.3 `heart.evaluateActivity(intent)` (Service)
评估某项非紧急外部自主活动是否符合当前心境与配额，返回建议。

- **输入参数**：
```typescript
interface ActivityIntent {
  intent: string;                  // 活动名称，如 "browse_bilibili"
  category?: string;                // 类别标识，如 "bilibili" | "fun" | "study" | "rest"
  estimatedDurationMinutes?: number;// 预计耗时（分钟）
}
```
- **返回结果**：
```typescript
interface ActivityEvaluation {
  suitable: boolean;
  reason: string;
  currentMood: string;
  quota?: {
    used: number;
    cap: number;
    remaining: number;
  };
  recommendation: string;
}
```
- **注意**：适宜建议不等于执行授权，具体活动执行仍由调用方插件独立负责。

### 2.4 `heart/state-changed` (Event)
当状态（Mood 或重要感知）发生实质变化时通知表达器官。

- **事件负载**：
```typescript
interface StateChangedEvent {
  prev: HeartSnapshot;
  current: HeartSnapshot;
  eventSource: string;
  timestamp: string;
}
```
- **分发机制**：通过 `ctx.parallel('heart/state-changed', event)` 并发派发，不阻塞主流程。

### 2.5 `heart/idle` (Event)
当空闲条件成立（达到最小空闲时间、无新对话、未处于安静时段且尚有配额）时发布。

- **事件负载**：
```typescript
interface IdleEvent {
  timestamp: string;
  sinceMsgMin: number;
  availableCategories: string[];
  quotaRemaining: number;
}
```
- **分发机制**：习惯类插件（如 bili-scroll）监听到后自行调用 `evaluateActivity` 并按各自节律执行。

---

## 3. 插件热插拔与优雅降级规范

1. **依赖声明**：
   - 依赖 Heart 的插件在 Cordis 中声明 `inject: ['heart']`。
   - 若插件希望在无 Heart 状态下独立运行，采用可选检查 `ctx.get('heart')`。
2. **生命周期清理**：
   - 监听事件必须使用 `ctx.on('heart/state-changed', ...)`。当插件被卸载或热重载时，Cordis Fiber 机制自动注销监听，杜绝内存泄漏和重复监听。
3. **容错隔离**：
   - 外部插件内部抛出的异常绝不能影响 Heart Core 的内部数据存储。
   - Heart 不可用时，外部插件自动回退至默认静默模式。
