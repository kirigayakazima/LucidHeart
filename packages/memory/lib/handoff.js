/**
 * @dsh/memory - Session Continuity Handoff Manager (极简跨会话接力器)
 *
 * 核心机制:
 * 1. 极简刷盘 (turn/end): 对话每轮结束将最后一句对话原子写入 last_handoff.json (<1KB，分通道隔离)
 * 2. 身份隔离 (Channel & Scope Isolation): 私聊 (direct) 与群聊 (group) 强隔离，群聊绝对不注入私聊隐私
 * 3. 首轮注入 (Turn 1 Injected User Context): 新会话第 1 轮前置注入 [交接线索: 上次聊到...]
 * 4. 保护缓存 (KV-Cache Friendly): System Prompt 100% 保持静态，不改变 16.5K 工具前缀
 * 5. 零开销 (Zero-LLM Overhead): 纯粹结构化提取，0 次模型调用，0 毫秒感知延迟
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 计算会话交接的唯一分区 Key
 * @param {Object} params
 * @param {string} [params.channel] 'direct' | 'group'
 * @param {string} [params.targetId] 群号或对方 ID
 * @param {string} [params.speaker] 发言者 ID
 * @returns {string}
 */
export function resolveHandoffKey({ channel = 'direct', targetId = null, speaker = null } = {}) {
  const ch = ['direct', 'group'].includes(channel) ? channel : 'direct';
  if (ch === 'group') {
    return targetId ? `group:${targetId}` : 'group:default';
  }
  return speaker ? `direct:${speaker}` : 'direct:default';
}

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
 * 从数据目录读取指定通道与身份的 last_handoff.json
 * @param {string} dataDir 
 * @param {Object} [criteria] 过滤条件
 * @param {string} [criteria.channel] 'direct' | 'group'
 * @param {string} [criteria.targetId] 群号或频道 ID
 * @param {string} [criteria.speaker] 发言者
 * @returns {Object|null}
 */
export function loadLastHandoff(dataDir, criteria = {}) {
  if (!dataDir) return null;
  const filePath = path.join(dataDir, 'last_handoff.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;

    const channel = criteria.channel || 'direct';
    const targetId = criteria.targetId || null;
    const speaker = criteria.speaker || null;

    if (parsed.scopes && typeof parsed.scopes === 'object') {
      if (channel === 'group') {
        if (targetId && parsed.scopes[`group:${targetId}`]) {
          return parsed.scopes[`group:${targetId}`];
        }
        if (parsed.scopes['group:default']) {
          return parsed.scopes['group:default'];
        }
        return null;
      }

      // direct 通道
      if (speaker && parsed.scopes[`direct:${speaker}`]) {
        return parsed.scopes[`direct:${speaker}`];
      }
      if (parsed.scopes['direct:default']) {
        return parsed.scopes['direct:default'];
      }
      const directKeys = Object.keys(parsed.scopes).filter(k => k.startsWith('direct:'));
      if (directKeys.length === 1) {
        return parsed.scopes[directKeys[0]];
      }
      return null;
    }

    // 兼容旧版扁平结构
    if (parsed.lastExchange) {
      if (channel === 'direct') {
        return { channel: 'direct', ...parsed };
      }
      // 安全熔断：绝不把未分区的私聊交接送进群聊
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 分区原子化写入 last_handoff.json (<1KB，分通道隔离，耗时 <1ms)
 * @param {string} dataDir 
 * @param {Object} handoffData 
 */
export function saveLastHandoff(dataDir, handoffData) {
  if (!dataDir || !handoffData) return;
  const filePath = path.join(dataDir, 'last_handoff.json');
  const tmpPath = path.join(dataDir, `last_handoff.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
  try {
    let store = { version: 'handoff-v2', scopes: {} };
    if (fs.existsSync(filePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (existing?.scopes && typeof existing.scopes === 'object') {
          store = existing;
        } else if (existing?.lastExchange) {
          store.scopes['direct:default'] = {
            channel: 'direct',
            sessionId: existing.sessionId || '',
            updatedAt: existing.updatedAt || new Date().toISOString(),
            lastExchange: existing.lastExchange,
          };
        }
      } catch {}
    }

    const channel = ['direct', 'group'].includes(handoffData.channel) ? handoffData.channel : 'direct';
    const key = resolveHandoffKey({
      channel,
      targetId: handoffData.targetId,
      speaker: handoffData.speaker,
    });

    store.scopes[key] = {
      sessionId: handoffData.sessionId || '',
      channel,
      speaker: handoffData.speaker || null,
      targetId: handoffData.targetId || null,
      scope: handoffData.scope || null,
      updatedAt: handoffData.updatedAt || new Date().toISOString(),
      lastExchange: {
        user: (handoffData.lastExchange?.user || '').trim().slice(0, 300),
        assistant: (handoffData.lastExchange?.assistant || '').trim().slice(0, 500),
      },
    };

    const payload = JSON.stringify(store, null, 2);
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * 拼装极简交接线索（控制在 60~80 tokens 内，严格执行通道隔离）
 * @param {Object} params
 * @param {Object} [params.lastHandoff]
 * @param {Object} [params.commitment]
 * @param {string} [params.channel] 'direct' | 'group'
 * @param {Date} [params.now]
 * @returns {string}
 */
export function buildHandoffClue({ lastHandoff, commitment, channel = 'direct', now = new Date() }) {
  const parts = [];

  if (lastHandoff?.lastExchange) {
    // 频道边界安全校验：若 handoff 标有 channel 且与当前通道不一致，严禁注入对话
    if (lastHandoff.channel && lastHandoff.channel !== channel) {
      return '';
    }

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
    // 严格通道隔离：承诺条目的 channel 必须与当前通道匹配，群聊严禁泄露私聊约定
    if (!commitment.channel || commitment.channel === channel) {
      const cleanTitle = commitment.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
      const target = commitment.targetTime || '近期';
      parts.push(`待履约约定: 「${cleanTitle}」(${target})`);
    }
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
 * 判断当前轮次是否满足首轮交接注入条件（严格校验通道与身份边界）
 * @param {Object} params
 * @param {Object} params.lastHandoff
 * @param {string} params.currentSessionId
 * @param {string} [params.channel] 'direct' | 'group'
 * @param {string} [params.targetId] 群号或频道 ID
 * @param {string} [params.speaker] 发言者 ID
 * @param {Array} [params.messages]
 * @param {Set} [params.injectedSessions]
 * @param {Date} [params.now]
 * @returns {boolean}
 */
export function shouldInjectHandoff({
  lastHandoff,
  currentSessionId,
  channel = 'direct',
  targetId = null,
  speaker = null,
  messages,
  injectedSessions,
  now = new Date(),
}) {
  if (!lastHandoff || !currentSessionId) return false;
  if (injectedSessions && currentSessionId && injectedSessions.has(currentSessionId)) {
    return false; // 本会话已注入过，绝不重复注入
  }

  // 1. 严格频道隔离：当前是群聊，绝对不允许读取私聊；当前是私聊，绝对不允许读取群聊
  const handoffChannel = lastHandoff.channel || 'direct';
  if (handoffChannel !== channel) {
    return false;
  }

  // 2. 群聊安全边界：若为群聊，必须匹配同一群组 targetId
  if (channel === 'group') {
    if (targetId && lastHandoff.targetId && targetId !== lastHandoff.targetId) {
      return false;
    }
  }

  // 3. 私聊边界：若有不同 speaker 标识且不一致，严禁跨人注入
  if (channel === 'direct') {
    if (speaker && lastHandoff.speaker && speaker !== lastHandoff.speaker) {
      return false;
    }
  }

  // 首轮判定：历史消息为空或只有系统/初始消息
  const isFirstTurn = !Array.isArray(messages) || messages.filter(m => m.role === 'user').length <= 1;
  if (!isFirstTurn) return false;

  // 会话切换判定：会话 ID 变更，或距离上次对话超过 1 小时
  if (lastHandoff.sessionId && currentSessionId && lastHandoff.sessionId !== currentSessionId) {
    return true;
  }
  if (lastHandoff.updatedAt) {
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
