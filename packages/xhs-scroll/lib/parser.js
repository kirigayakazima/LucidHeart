const sites = new Set(['www.xiaohongshu.com', 'xiaohongshu.com'])
const shortSites = new Set(['xhslink.com', 'www.xhslink.com'])
const notePath = /^\/(?:discovery\/item|explore)\/([0-9a-f]{24})\/?$/i

function https(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null
  } catch { return null }
}

export function noteUrl(value) {
  const url = https(value)
  if (!url || url.href.length > 2048) return null
  if (shortSites.has(url.hostname) && /^\/(?:a\/)?[\w-]{1,100}\/?$/.test(url.pathname)) return { url, short: true }
  const id = sites.has(url.hostname) ? notePath.exec(url.pathname)?.[1].toLowerCase() : null
  return id ? { url, id } : null
}

export function imageUrl(value) {
  const url = https(value)
  return url && url.href.length <= 2048 && /^(?:[a-z0-9-]+\.)+xhscdn\.com$/.test(url.hostname) ? url : null
}

export const plain = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : ''

// Read the JSON assignment only. The page occasionally uses bare undefined;
// normalize it outside quoted strings, and never execute the surrounding script.
export function extractInitialState(html) {
  if (typeof html !== 'string' || html.length > 3 * 1024 * 1024) return null
  const marker = /(?:^|[;>\s])(?:window\s*\.\s*)?__INITIAL_STATE__\s*=\s*\{/g
  let attempts = 0
  for (const match of html.matchAll(marker)) {
    if (++attempts > 8) break
    const start = match.index + match[0].length - 1
    let depth = 0, literal = false, escaped = false, last = start
    const parts = []
    for (let i = start; i < html.length; i++) {
      const char = html[i]
      if (literal) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') literal = false
        continue
      }
      if (char === '"') literal = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(parts.join('') + html.slice(last, i + 1)) } catch { break }
      } else if (char === 'u' && html.startsWith('undefined', i) && /[\s:[,]/.test(html[i - 1]) &&
                 /[\s,\]}]/.test(html[i + 9] ?? '')) {
        parts.push(html.slice(last, i), 'null')
        i += 8
        last = i + 1
      }
    }
  }
  return null
}

function counter(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : plain(value, 30) || null
}

export function parseNote(html, id) {
  const map = extractInitialState(html)?.note?.noteDetailMap
  const note = map && Object.hasOwn(map, id) ? map[id]?.note : null
  const title = plain(note?.title, 200), desc = plain(note?.desc, 4000)
  const images = Array.isArray(note?.imageList) ? note.imageList.slice(0, 40).map(item => {
    const best = Array.isArray(item?.infoList) && item.infoList.find(x => x?.imageScene === 'WB_DFT')?.url
    return [item?.urlDefault, best, item?.url, item?.urlPre].map(imageUrl).find(Boolean)?.href
  }).filter(Boolean) : []
  if (!title && !desc && !images.length) return null
  return { id, title, desc, author: plain(note?.user?.nickname, 100),
    tags: Array.isArray(note?.tagList) ? note.tagList.slice(0, 24).map(tag => plain(tag?.name, 60)).filter(Boolean) : [],
    likes: counter(note?.interactInfo?.likedCount), saves: counter(note?.interactInfo?.collectedCount),
    images: [...new Set(images)] }
}
