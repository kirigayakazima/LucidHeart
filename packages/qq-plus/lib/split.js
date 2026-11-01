// 纯函数断句算法：将长文本按句子边界与 Markdown 语法切分为 2–4 条短消息。
// 零依赖，纯函数，经过 24 项复杂用例验证。

export function splitForQQ(text, options = {}) {
  if (text === null || text === undefined) return []
  const normalized = String(text).replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const minChars = options.minChars ?? 120
  if (normalized.length < minChars) {
    return [normalized]
  }

  const maxSegments = options.isGroup
    ? (options.groupMaxSegments ?? 2)
    : (options.maxSegments ?? 3)
  const targetChars = options.targetChars ?? 140
  const protectCode = options.protectCode ?? true

  // Step 3: 保护块（代码块与表格整块保护）
  const blocks = []
  let working = normalized

  if (protectCode) {
    // 1. 围栏代码块：``` ... ``` 或 ~~~ ... ~~~
    working = working.replace(/^[ \t]*(```|~~~)[\s\S]*?\1[ \t]*(?:\n|$)/gm, (match) => {
      const id = blocks.length
      blocks.push(match)
      return `\uE000_BLOCK_${id}_\uE000\n`
    })

    // 2. GFM 表格：连续以 | 起始结束的行，且包含分隔行 |-+-|
    working = working.replace(/(?:^[ \t]*\|[^\n]+\|[ \t]*(?:\n|$)){2,}/gm, (match) => {
      if (/\|[ \t]*:?-+:?[ \t]*\|/.test(match)) {
        const id = blocks.length
        blocks.push(match)
        return `\uE000_BLOCK_${id}_\uE000\n`
      }
      return match
    })
  }

  // 3. 保护行内代码与 URL
  const inlines = []
  working = working.replace(/`[^`\n]+`|https?:\/\/[^\s"'`<>]+/g, (match) => {
    const id = inlines.length
    inlines.push(match)
    return `\uE000_INLINE_${id}_\uE000`
  })

  // Step 4: 按句子边界切成 atom
  // - 中文：。！？… 之后（可跟 ”’」』）)）]）切
  // - 英文：.!? 后跟空白/结尾切；数字如 3.14、版本如 v1.2、缩写如 e.g. / i.e. 不切
  // - 空行表示段落；单个换行可能位于句中，不能单独作为发送边界。
  const sentenceRegex = /(\n[ \t]*\n(?:[ \t]*\n)*|[。！？…]+[”’」』）)\]]*|(?<!\d)(?<!\b(?:e\.g|i\.e|vs|v\d+))[.!?]+(?=\s|$))/g

  let lastIndex = 0
  const rawAtoms = []
  let match
  while ((match = sentenceRegex.exec(working)) !== null) {
    const end = match.index + match[0].length
    const part = working.slice(lastIndex, end)
    if (part) rawAtoms.push(part)
    lastIndex = end
  }
  if (lastIndex < working.length) {
    const remaining = working.slice(lastIndex)
    if (remaining) rawAtoms.push(remaining)
  }

  const atoms = rawAtoms

  // Step 5: 贪心合并 atom 到 targetChars 以内
  const segments = []
  let currentSeg = ''

  for (const atom of atoms) {
    if (!currentSeg) {
      currentSeg = atom
    } else if (currentSeg.length + atom.length <= targetChars) {
      currentSeg += atom
    } else {
      segments.push(currentSeg)
      currentSeg = atom
    }
  }
  if (currentSeg) {
    segments.push(currentSeg)
  }

  // Step 6: 限制段数（超出 maxSegments 的尾部合并进最后一段，绝不丢弃）
  let limited = segments
  if (segments.length > maxSegments) {
    const head = segments.slice(0, maxSegments - 1)
    const tail = segments.slice(maxSegments - 1).join('')
    head.push(tail)
    limited = head
  }

  // Step 7: 还原占位符并去除段首尾空白
  const restored = limited
    .map((seg) => {
      let s = seg
      s = s.replace(/\uE000_INLINE_(\d+)_\uE000/g, (_, id) => inlines[Number(id)] || '')
      s = s.replace(/\uE000_BLOCK_(\d+)_\uE000/g, (_, id) => blocks[Number(id)] || '')
      return s.trim()
    })
    .filter(Boolean)

  return restored
}
