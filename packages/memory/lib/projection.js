import { formatConversationProjection } from './budget.js';

export { formatConversationProjection };

export function projectConversation(indexer, query, { scope, label }) {
  return formatConversationProjection(indexer.search(query, { scope, limit: 8, projection: true }), label);
}
