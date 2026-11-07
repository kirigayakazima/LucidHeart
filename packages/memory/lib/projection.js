export function projectConversation(indexer, query, { scope, label }) {
  return formatConversationProjection(indexer.search(query, { scope, limit: 3, projection: true }), label);
}

export function formatConversationProjection(entries, label = '小满的回忆') {
  const prefix = `[${label}: `;
  const items = [];
  let text = '';
  for (const { content } of entries) {
    const fact = content.replace(/\s+/g, ' ').trim().replace(/\{/g, '｛').replace(/\}/g, '｝');
    if (!fact) continue;
    const item = `${items.length + 1}. ${fact}`;
    const next = prefix + [...items, item].join('; ') + ']';
    // UTF-8 bytes give a conservative ceiling for byte-based tokenizers.
    if ([...next].length > 120 || Buffer.byteLength(next) > 100) continue;
    items.push(item);
    text = next;
    if (items.length === 3) break;
  }
  return text;
}
