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

export function isCandidateOrigin(origin) {
  return origin === 'model_inference' || origin === 'casual_chat';
}

export function isCandidateProvenance(provenance) {
  if (provenance?.claimType === undefined) return isCandidateOrigin(provenance?.origin);
  return provenance.origin !== 'user_request' || provenance.evidenceStatus !== 'resolved' ||
    !['user_statement', 'observation'].includes(provenance.claimType);
}
