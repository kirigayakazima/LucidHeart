// Shadow policy only. This module is deliberately not imported by MemoryService.
export const POLICY_VERSION = 'memory-shape-shadow-v1';
const IMPORTANCE = { principle: 1, fact: 0.9, preference: 0.9, relationship: 0.95, episodic: 0.55, insight: 0.4 };

export function scoreNode(node, { now, halfLifeDays = 30 } = {}) {
  const clock = Date.parse(now);
  if (!Number.isFinite(clock) || !Number.isFinite(halfLifeDays) || !(halfLifeDays > 0)) throw new Error('Invalid scoring clock/policy');
  const importance = IMPORTANCE[node.type] ?? 0.4;
  const confidence = Number.isFinite(node.confidence) && node.confidence >= 0 && node.confidence <= 1
    ? node.confidence : null;
  const timestamp = Date.parse(node.t);
  const ageDays = Number.isFinite(timestamp) ? Math.max(0, (clock - timestamp) / 86400000) : null;
  const decays = node.type === 'episodic' && !node.pinned;
  const retention = decays && ageDays !== null ? Math.max(0.05, 2 ** (-ageDays / halfLifeDays)) : 1;
  const candidate = node.status === 'candidate';
  const from = Date.parse(node.validFrom), until = Date.parse(node.validTo);
  const validNow = (!Number.isFinite(from) || from <= clock) && (!Number.isFinite(until) || until > clock);
  const eligibleForRecall = node.layer === 'current' && node.status === 'active' && validNow;
  return {
    policy: POLICY_VERSION, importance, confidence, ageDays, retention,
    displayWeight: importance * retention * (candidate ? (confidence ?? 0.5) : 1),
    eligibleForRecall,
    reasons: [
      `kind:${node.type}`, decays ? `episode-half-life:${halfLifeDays}d` : 'stable-or-pinned',
      ...(ageDays === null ? ['time-unknown:no-decay-inferred'] : []),
      ...(candidate ? ['candidate:not-a-confirmed-fact'] : []),
      ...(eligibleForRecall ? ['current-active:query-relevance-not-evaluated'] : ['excluded-from-current-recall']),
    ],
  };
}
