export const IntakeWeights = Object.freeze({
  user_statement: 0.95,
  shared_experience: 0.85,
  casual_chat: 0.3,
  model_inference: 0.35,
});

export const ProvenanceOrigins = Object.freeze(['user_request', 'autonomous', 'external', 'unknown']);
export const ClaimTypes = Object.freeze(['user_statement', 'observation', 'model_inference', 'legacy_unknown']);
export const RetentionClasses = Object.freeze(['stable', 'episodic', 'pinned', 'unknown']);
export const EvidenceStatuses = Object.freeze(['resolved', 'unavailable', 'unknown']);
export const ConversationChannels = Object.freeze(['direct', 'group']);
export const FreshnessStates = Object.freeze(['active', 'expired', 'superseded']);

export function freshnessOf(entry, now = Date.now()) {
  if (entry.status === 'superseded' || entry.freshness === 'superseded') return 'superseded';
  if (entry.freshness === 'expired' || (entry.validUntil && Date.parse(entry.validUntil) <= now)) return 'expired';
  return 'active';
}

// Audience describes common ground, not a second store or an access-control tenant.
export function isCommonKnowledge(entry, context) {
  if (context?.channel !== 'group') return true;
  return entry.audience?.some(a => a.channel === 'group' && a.targetId === context.targetId &&
    (!context.participants?.length || context.participants.every(id => a.participants?.includes(id)))) ?? false;
}

export function isCandidateOrigin(origin) {
  return origin === 'model_inference' || origin === 'casual_chat';
}

export function isCandidateProvenance(provenance) {
  if (provenance?.claimType === undefined) return isCandidateOrigin(provenance?.origin);
  return provenance.origin !== 'user_request' || provenance.evidenceStatus !== 'resolved' ||
    !['user_statement', 'observation'].includes(provenance.claimType);
}
