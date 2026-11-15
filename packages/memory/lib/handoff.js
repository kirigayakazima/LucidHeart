/**
 * @dsh/memory - Session Continuity Handoff Manager (极简跨会话接力器)
 *
 * 核心机制:
 * 1. 极简刷盘 (turn/end): 对话每轮结束将最后一句对话原子写入 last_handoff.json (<300 字节，<1ms)
 * 2. 首轮注入 (Turn 1 Injected User Context): 新会话第 1 轮前置注入 [交接线索: 上次聊到...]
 * 3. 保护缓存 (KV-Cache Friendly): System Prompt 100% 保持静态，不改变 16.5K 工具前缀
 * 4. 零开销 (Zero-LLM Overhead): 纯粹结构化提取，0 次模型调用，0 毫秒感知延迟
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 格式化相对时间描述（如：昨晚 23:30、今天 08:15、11月14日）
 * @param {Date} date 
 * @param {Date} now 
 * @returns {string}
 */
export function formatRelativeTime(date, now = new Date()) {
  if (!date || isNaN(date.getTime())) return '';
  const diffMs = now.getTime() - date.getTime();
  const diffHours = diffMs / (3600 * 1000);

  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  // 同一天
  if (date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()) {
    if (hours < 6) return `今天凌晨 ${timeStr}`;
    if (hours < 12) return `今天上午 ${timeStr}`;
    if (hours < 18) return `今天下午 ${timeStr}`;
    return `今天晚上 ${timeStr}`;
  }

  // 昨天
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate()) {
    if (hours >= 18 || hours < 4) return `昨晚 ${timeStr}`;
    return `昨天 ${timeStr}`;
  }

  // 前天
  const beforeYesterday = new Date(now);
  beforeYesterday.setDate(beforeYesterday.getDate() - 2);
  if (date.getFullYear() === beforeYesterday.getFullYear() &&
      date.getMonth() === beforeYesterday.getMonth() &&
      date.getDate() === beforeYesterday.getDate()) {
    return `前天 ${timeStr}`;
  }

  // 较早日期
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 从数据目录读取最新的 last_handoff.json
 * @param {string} dataDir 
 * @returns {Object|null}
 */
export function loadLastHandoff(dataDir) {
  if (!dataDir) return null;
  const filePath = path.join(dataDir, 'last_handoff.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 原子化写入 last_handoff.json (<300 字节，耗时 <1ms)
 * @param {string} dataDir 
 * @param {Object} handoffData 
 */
export function saveLastHandoff(dataDir, handoffData) {
  if (!dataDir || !handoffData) return;
  const filePath = path.join(dataDir, 'last_handoff.json');
  const tmpPath = path.join(dataDir, `last_handoff.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
  try {
    const payload = JSON.stringify({
      sessionId: handoffData.sessionId || '',
      updatedAt: handoffData.updatedAt || new Date().toISOString(),
      lastExchange: {
        user: (handoffData.lastExchange?.user || '').trim().slice(0, 300),
        assistant: (handoffData.lastExchange?.assistant || '').trim().slice(0, 500),
      },
    }, null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * 拼装极简交接线索（控制在 60~80 tokens 内）
 * @param {Object} params
 * @param {Object} [params.lastHandoff]
 * @param {Object} [params.commitment]
 * @param {Date} [params.now]
 * @returns {string}
 */
export function buildHandoffClue({ lastHandoff, commitment, now = new Date() }) {
  const parts = [];

  if (lastHandoff?.lastExchange) {
    const { user, assistant } = lastHandoff.lastExchange;
    const lastDate = lastHandoff.updatedAt ? new Date(lastHandoff.updatedAt) : null;
    const timeDesc = formatRelativeTime(lastDate, now);

    const cleanUser = (user || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 50);
    const cleanAssistant = (assistant || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);

    if (cleanUser || cleanAssistant) {
      const timePrefix = timeDesc ? `${timeDesc}交流` : '上次交流';
      let exchangeDesc = '';
      if (cleanUser && cleanAssistant) {
        exchangeDesc = `用户曾说「${cleanUser}」，你回复「${cleanAssistant}」`;
      } else if (cleanUser) {
        exchangeDesc = `用户曾提到「${cleanUser}」`;
      } else {
        exchangeDesc = `你曾回复「${cleanAssistant}」`;
      }
      parts.push(`${timePrefix}: ${exchangeDesc}`);
    }
  }

  if (commitment && commitment.title) {
    const cleanTitle = commitment.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
    const target = commitment.targetTime || '近期';
    parts.push(`待履约约定: 「${cleanTitle}」(${target})`);
  }

  if (parts.length === 0) return '';
  return `[交接线索: ${parts.join('；')}。请自然承接，语气亲昵贴心，若合适可主动关心。]\n\n`;
}

/**
 * 提取消息体中的纯文本内容
 * @param {Object} message 
 * @returns {string}
 */
export function extractTextFromMessage(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * 判断当前轮次是否满足首轮交接注入条件
 * @param {Object} params
 * @param {Object} params.lastHandoff
 * @param {string} params.currentSessionId
 * @param {Array} [params.messages]
 * @param {Set} [params.injectedSessions]
 * @param {Date} [params.now]
 * @returns {boolean}
 */
export function shouldInjectHandoff({
  lastHandoff,
  currentSessionId,
  messages,
  injectedSessions,
  now = new Date(),
}) {
  if (!lastHandoff && !currentSessionId) return false;
  if (injectedSessions && currentSessionId && injectedSessions.has(currentSessionId)) {
    return false; // 本会话已注入过，绝不重复注入
  }

  // 首轮判定：历史消息为空或只有系统/初始消息
  const isFirstTurn = !Array.isArray(messages) || messages.filter(m => m.role === 'user').length <= 1;
  if (!isFirstTurn) return false;

  // 会话切换判定：会话 ID 变更，或距离上次对话超过 1 小时
  if (lastHandoff?.sessionId && currentSessionId && lastHandoff.sessionId !== currentSessionId) {
    return true;
  }
  if (lastHandoff?.updatedAt) {
    const lastDate = new Date(lastHandoff.updatedAt);
    if (!isNaN(lastDate.getTime())) {
      const elapsedMs = now.getTime() - lastDate.getTime();
      if (elapsedMs >= 3600 * 1000) { // 超过 1 小时
        return true;
      }
    }
  }

  // 若从未有过 handoff 记录或完全相同 session 且未超时，则不注入
  return false;
}

/**
 * 安全地将交接线索前置注入到用户输入消息中
 * 保持模型看到完整线索，同时同步修正 qq.start 偏移，避免污染取证与记忆摄取
 * @param {Object} message 
 * @param {string} clue 
 */
export function injectHandoffToMessage(message, clue) {
  if (!message || !clue) return;
  if (!Array.isArray(message.content) || message.content.length === 0) {
    message.content = [{ type: 'text', text: clue }];
    return;
  }

  const block = message.content[0];
  if (block && block.type === 'text' && typeof block.text === 'string') {
    block.text = clue + block.text;
    // 若来自 QQ，调整实际发言区间的 start 偏移
    if (message.source?.qq && Number.isSafeInteger(message.source.qq.start)) {
      message.source.qq.start += clue.length;
    }
  }
}
