// Heart Protocol v1: 核心类型、常量与事件契约定义
// 遵循零外部依赖原则，可在任何 Node.js / DSH 环境中运行。

export const HEART_PROTOCOL_VERSION = '1.0.0'
export const HEART_CORE_VERSION = '0.20.0'

/** Cordis 事件名称契约 */
export const HEART_EVENTS = Object.freeze({
  /** 状态变化通知事件（只读通知，由表达器官如 Live2D、语音、表情等订阅） */
  STATE_CHANGED: 'heart/state-changed',
  /** 空闲条件成立通知事件（通知习惯插件如 bili-scroll，由插件自行判断是否参与） */
  IDLE: 'heart/idle',
})

/** 支持的标准感知来源 */
export const SENSORY_SOURCES = Object.freeze([
  'qq',
  'fullawake',
  'desktop',
  'sticker-look',
  'system',
  'custom',
])

/** 支持的标准感知类型 */
export const SENSORY_TYPES = Object.freeze([
  'sticker',   // 表情包 / 图像感知
  'wake',      // 消息唤醒 / 用户主动唤起
  'vision',    // 桌面 / 屏幕视觉感知
  'audio',     // 语音音调 / 听觉感知
  'sensor',    // 设备传感器 / 系统状态（如屏幕开闭）
  'activity',  // 外部活动状态汇报
  'custom',    // 自定义扩展
])

/** 错误代码契约 */
export const ERROR_CODES = Object.freeze({
  INVALID_OBSERVATION: 'ERR_HEART_INVALID_OBSERVATION',
  INVALID_INTENT: 'ERR_HEART_INVALID_INTENT',
  STATE_LOCKED: 'ERR_HEART_STATE_LOCKED',
  INTERNAL_ERROR: 'ERR_HEART_INTERNAL_ERROR',
  UNAVAILABLE: 'ERR_HEART_UNAVAILABLE',
})
