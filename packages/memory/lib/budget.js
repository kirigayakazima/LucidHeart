/**
 * @dsh/memory - Context Budget & Progressive Disclosure Controller
 *
 * 核心机制：
 * 1. 估算与计量 Token 开销 (中英混合文本精细估算)
 * 2. 渐进式披露：初始召回仅注入骨架摘要 (Compact Outline)，不倾倒冗余细节
 * 3. 动态预算控制：根据场景严格截断候选条目，防止上下文挤压
 */

/**
 * 快速估算文本占用的 Token 数量
 * 经验法则：
 * - 英文/标点/代码：约 4 字符 / Token
 * - 中文字符：约 1.5 ~ 1.8 字符 / Token
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  let chineseChars = 0;
  let otherChars = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fa5) {
      chineseChars++;
    } else {
      otherChars++;
    }
  }

  return Math.ceil(chineseChars / 1.6 + otherChars / 4.0);
}

/**
 * 将检索出的记忆格式化为渐进式披露的紧凑骨架 (Compact Outline)
 * @param {Array<any>} entries
 * @param {Object} options
 * @param {number} [options.maxTokens=300] 预算上限 Token
 * @returns {{ text: string, count: number, usedTokens: number }}
 */
export function formatCompactOutline(entries, { maxTokens = 300 } = {}) {
  if (!entries || entries.length === 0) {
    return { text: '', count: 0, usedTokens: 0 };
  }

  const lines = ['【相关记忆参考 (紧凑摘要，如需详情请调用 memory_inspect)】:'];
  let currentTokens = estimateTokens(lines[0]);
  let addedCount = 0;

  for (const item of entries) {
    const date = (item.validFrom || item.createdAt || '').slice(0, 10);
    const scopeTag = item.scope === 'shared' ? '[共享]' : '';
    const line = `- [${item.id}] ${date} ${scopeTag} [${item.kind}] ${item.content}`;
    const lineTokens = estimateTokens(line);

    if (currentTokens + lineTokens > maxTokens && addedCount > 0) {
      break;
    }

    lines.push(line);
    currentTokens += lineTokens;
    addedCount++;
  }

  return {
    text: lines.join('\n'),
    count: addedCount,
    usedTokens: currentTokens,
  };
}

/**
 * 手术式工具输出裁剪 (借鉴 tool-result-pruner 机制)
 * @param {string} text 原始工具输出
 * @param {number} [maxChars=1000] 最大允许字符数
 * @returns {string} 裁剪后保留头尾的安全文本
 */
export function pruneToolOutput(text, maxChars = 1000) {
  if (!text || text.length <= maxChars) return text;

  const headChars = Math.floor(maxChars * 0.4);
  const tailChars = Math.floor(maxChars * 0.4);
  const omitted = text.length - headChars - tailChars;

  return `${text.slice(0, headChars)}\n\n[... 已省略中间 ${omitted} 字符冗余输出 ...] \n\n${text.slice(-tailChars)}`;
}
