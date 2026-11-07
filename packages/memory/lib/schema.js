export const IntakeWeights = Object.freeze({
  user_statement: 0.95,
  shared_experience: 0.85,
  casual_chat: 0.3,
  model_inference: 0.35,
});

export function isCandidateOrigin(origin) {
  return origin === 'model_inference' || origin === 'casual_chat';
}
