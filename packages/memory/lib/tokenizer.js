/**
 * @dsh/memory - Zero-dependency Chinese & Multilingual Bi-Gram Tokenizer for SQLite FTS5
 */

const CJK_REGEX = /[\u4e00-\u9fa5]/;
const PUNCT_REGEX = /[^\w\s\u4e00-\u9fa5]/g;

/**
 * 将混合文本转换为适合 SQLite FTS5 索引与检索的 Token 串
 * 核心机制：
 * 1. 英文/数字：按单词切分、全部小写化
 * 2. 中文单字与二元分词 (Bi-Gram)：
 *    例如 "小满专属记忆" => 生成 "小 满 专 属 记 忆 小满 满专 专属 属记 记忆"
 *    这样无论是单字搜索还是短语搜索，FTS5 都能精准命中，且零外部 C 库或 Python 依赖。
 *
 * @param {string} text
 * @returns {string} 适合 FTS5 的空格分隔 token 串
 */
export function tokenizeForFTS(text) {
  if (!text || typeof text !== 'string') return '';

  // 1. 过滤特殊标点符号并小写化
  const cleaned = text.replace(PUNCT_REGEX, ' ').toLowerCase();
  const tokens = [];

  // 2. 扫描字符流
  let currentLatinWord = '';
  const chineseChars = [];

  const flushLatin = () => {
    if (currentLatinWord) {
      tokens.push(currentLatinWord);
      currentLatinWord = '';
    }
  };

  const flushChinese = () => {
    if (chineseChars.length === 0) return;
    // 输出一元 (unigram)
    for (const ch of chineseChars) {
      tokens.push(ch);
    }
    // 输出二元 (bi-gram)
    for (let i = 0; i < chineseChars.length - 1; i++) {
      tokens.push(chineseChars[i] + chineseChars[i + 1]);
    }
    chineseChars.length = 0;
  };

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (CJK_REGEX.test(char)) {
      flushLatin();
      chineseChars.push(char);
    } else if (/\w/.test(char)) {
      flushChinese();
      currentLatinWord += char;
    } else {
      // 空白字符或已被替换的分隔符
      flushLatin();
      flushChinese();
    }
  }

  flushLatin();
  flushChinese();

  return tokens.join(' ');
}

/**
 * 将用户检索 Query 转化为 FTS5 MATCH 表达式
 * 支持宽松 OR 匹配和精准短语提升
 * @param {string} query
 * @returns {string}
 */
export function buildFtsQuery(query) {
  const tokenized = tokenizeForFTS(query);
  if (!tokenized) return '';

  const terms = tokenized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return '';

  // 优先保留二元词和长英文词，提高命中精度
  const bigramsOrWords = terms.filter((t) => t.length > 1);
  if (bigramsOrWords.length > 0) {
    return bigramsOrWords.map((t) => `"${t}"`).join(' OR ');
  }

  return terms.map((t) => `"${t}"`).join(' OR ');
}
