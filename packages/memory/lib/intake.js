import { MemoryOrigins } from './types.js';
import { IntakeWeights } from './schema.js';
import { readQqUtterance, resolveHostContext } from './host-context.js';
import { findContradictions } from './contradictions.js';

const durableKinds = ['preference', 'relationship', 'episodic', 'fact'];
const routine = new Set(['早', '早安', '早上好', '晚安', '晚上好', '你好', '嗨', '哈喽', '在吗',
  '签到', '打卡', '早安打卡', '晚安打卡', '谢谢', '哈哈', 'hello', 'hi', 'good morning', 'good night']);
export function isRoutine(text) {
  const words = text.replace(/[\p{P}\p{S}]/gu, '').trim().toLowerCase();
  return !words || routine.has(words);
}

/** 从 QQ 驱动标注的位置取当前发言，排除同一消息内拼接的引用和群历史。 */
export function readConversationInput(message, { includeRoutine = false } = {}) {
  const input = readQqUtterance(message);
  if (input && (includeRoutine || !isRoutine(input.text))) return input;
}

const firstPerson = /^(?:我|本人)(?!们|的?(?:朋友|同事|家人|父母|爸|妈|哥|姐|弟|妹|孩子|对象|老公|老婆))/u;
const uncertain = /如果|假如|要是|假设|也许|可能|说不定|大概|据说|听说|我猜|我想象|我打算|我想要|吗$|么$|呢$/u;
const leadIn = /^(?:(?:其实|更正一下|补充一下|请记住|帮我记住|记住)[，,：:\s]*)+/u;
const comparable = text => text.normalize('NFKC').trim().replace(/[。！!.]+$/u, '').replace(/\s+/gu, ' ');
const stopTokens = new Set([...'我你他她它们的了呢吧啊哦呀嘛就都也把给在是有这那一个']);
const meaningfulTokens = text => [...text.normalize('NFKC').toLowerCase()]
  .filter(ch => /[\p{Script=Han}a-z0-9]/u.test(ch) && !stopTokens.has(ch));
const charBigrams = tokens => {
  const out = new Set();
  for (let i = 0; i < tokens.length - 1; i += 1) out.add(tokens[i] + tokens[i + 1]);
  return out;
};

function matchingStatement(rawSnippet, fact, quote, speaker, channel) {
  if (!rawSnippet || /[「」『』“”"《》]/u.test(rawSnippet)) return;
  const proposed = comparable(fact);
  for (const clause of rawSnippet.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? []) {
    const statement = clause.trim().replace(leadIn, '').replace(/[。！!；;]+$/u, '');
    if ((quote && !clause.includes(quote)) || /[?？]/u.test(statement) || uncertain.test(statement)) continue;
    const actual = comparable(statement);
    const selfReport = firstPerson.test(statement);
    if (actual === proposed) return { statement, firstPerson: selfReport };
    if (!selfReport) continue;
    const body = actual.replace(firstPerson, '');
    const subject = speaker === 'user' ? '用户' : speaker;
    if ((speaker && proposed === comparable(`${subject}${body}`)) ||
        (channel === 'direct' && proposed === `用户${body}`)) return { statement, firstPerson: true };
  }
}

function groundedEvidenceClause(rawSnippet, quote, content) {
  if (!rawSnippet || !content || /[「」『』“”"《》]/u.test(rawSnippet)) return null;
  const factTokens = meaningfulTokens(content);
  const factSet = new Set(factTokens);
  const factBigrams = charBigrams(factTokens);
  if (factSet.size === 0) return null;
  for (const clause of rawSnippet.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu) ?? []) {
    const statement = clause.trim().replace(leadIn, '').replace(/[。！!；;\s]+$/u, '');
    if (!statement || (quote && !clause.includes(quote)) || /[?？]/u.test(statement) || uncertain.test(statement)) continue;
    const rawTokens = meaningfulTokens(statement);
    const rawSet = new Set(rawTokens);
    if (rawSet.size === 0) continue;
    let matched = 0;
    for (const ch of rawSet) if (factSet.has(ch)) matched += 1;
    let matchedBigrams = 0;
    for (const bg of charBigrams(rawTokens)) if (factBigrams.has(bg)) matchedBigrams += 1;
    const recall = matched / rawSet.size;
    if (matched >= 2 && recall >= 0.45 && (matchedBigrams >= 1 || rawSet.size <= 3)) {
      return { statement, firstPerson: false };
    }
  }
  return null;
}

export function buildIntakeMetadata(host, { content, kind, origin, evidence, importance }) {
  const { sessionId, channel, speaker, messageId, observedAt, rawSnippet } = host;
  const isNativeDirect = host.origin === 'user_request' && !channel && Boolean(sessionId && messageId && observedAt);
  const effectiveChannel = channel || (isNativeDirect ? 'direct' : null);
  const effectiveSpeaker = speaker || (isNativeDirect ? 'user' : null);
  const statement = matchingStatement(rawSnippet, content, evidence, effectiveSpeaker, effectiveChannel)
    ?? groundedEvidenceClause(rawSnippet, evidence, content);
  const quote = evidence || statement?.statement;
  const resolved = host.origin === 'user_request' && Boolean(
    sessionId && effectiveChannel && effectiveSpeaker && messageId && observedAt &&
    quote && quote.length <= 120 && rawSnippet?.includes(quote)
  );
  let claimType = 'model_inference';
  if (resolved && origin !== 'model_inference' && origin !== 'casual_chat') {
    if (statement?.firstPerson) claimType = 'user_statement';
    else if (statement) claimType = 'observation';
  }
  return {
    source: {
      ...(sessionId && { sessionId }), ...(effectiveChannel && { channel: effectiveChannel }), ...(effectiveSpeaker && { speaker: effectiveSpeaker }),
      ...(messageId && { messageId }), ...(observedAt && { observedAt }),
      ...(quote && quote.length <= 120 && rawSnippet?.includes(quote) && { evidenceText: quote }),
    },
    provenance: { origin: host.origin, claimType, evidenceStatus: resolved ? 'resolved' : 'unavailable' },
    confidence: claimType === 'user_statement' ? IntakeWeights.user_statement
      : claimType === 'observation' ? IntakeWeights.shared_experience
      : origin === 'casual_chat' ? IntakeWeights.casual_chat : IntakeWeights.model_inference,
    confirmed: claimType === 'user_statement',
    ...(effectiveChannel === 'direct' && effectiveSpeaker && { audience: [{ channel: effectiveChannel, speaker: effectiveSpeaker }] }),
    ...(effectiveChannel === 'group' && host.targetId && { audience: [{ channel: effectiveChannel, targetId: host.targetId, participants: [effectiveSpeaker] }] }),
    ...(importance !== undefined && { importance, salience: { importance, reason: 'intake-importance', policyVersion: '1' } }),
    retentionClass: claimType === 'model_inference' ? 'unknown' : kind === 'episodic' ? 'episodic' : 'stable',
  };
}

/** At a checkpoint, retain only an explicit, verifiable new fact from its own completed turn. */
export function retainCheckpointFact(memory, events, { scope, sessionId, messageId }) {
  const start = events.findLastIndex(event => event.type === 'turn/start');
  if (start < 0 || events.at(-1)?.type !== 'turn/end') return false;
  const turn = events.slice(start + 1);
  if (turn.some(event => event.type === 'tool/call' && /^memory_(?:intake|remember|correct|forget)$/u.test(event.data?.name))) {
    return false;
  }
  const event = turn.findLast(item => item.type === 'user/message' && item.data?.source?.kind === 'user');
  if (!event || event.data.id !== messageId || !Number.isFinite(event.time) || event.time <= 0) return false;
  const qq = readQqUtterance(event.data);
  if (!qq || !/^(?:请记住|帮我记住|记住)[，,：:\s]/u.test(qq.text)) return false;
  const content = qq.text.replace(leadIn, '').replace(/[。！!]+$/u, '').trim();
  if (!firstPerson.test(content) || content.length > 90 ||
      !/^(?:我|本人)(?:长期|一直|住在|居住在|常住|喜欢|不喜欢|最喜欢|不吃|每天|通常|的生日是)/u.test(content)) return false;
  const kind = /^(?:我|本人)(?:喜欢|不喜欢|最喜欢|不吃)/u.test(content) ? 'preference' : 'fact';
  const metadata = buildIntakeMetadata({
    ...qq, sessionId, messageId, rawSnippet: qq.text, observedAt: new Date(event.time).toISOString(),
    origin: 'user_request', targetId: event.data.source.qq.targetId,
  }, { content, kind, evidence: content });
  if (!metadata.confirmed) return false;
  const entry = { content, kind, scope, ...metadata };
  memory.ensureProjections();
  if (memory.indexer.hasIntakeMatch(content, scope, false, { includeHistory: true }) ||
      findContradictions({ ...entry, status: 'active' }, memory.indexer).length) return false;
  memory.remember(entry);
  return true;
}

export function registerIntake(registerTool, memory, scope, currentInput) {
  registerTool({
    name: 'memory_intake',
    description: '静默沉淀本轮明确的稳定事实、个人偏好、长期约定或人生里程碑。更新住址、作息和偏好时也可使用。略过闲聊、问候、打卡、当下心情、转述和已经记过的内容。',
    parameters: {
      content: { type: 'string', required: true, description: '一句独立、简短的事实，最多 90 字，群聊中写明当事人' },
      kind: { type: 'string', required: true, enum: durableKinds, description: 'fact 稳定事实；preference 稳定偏好；relationship 长期约定；episodic 里程碑' },
      origin: { type: 'string', required: true, enum: MemoryOrigins, description: '直接陈述、明确共同经历、低置信度闲聊线索或基于本轮证据的推断' },
      evidence: { type: 'string', required: true, description: '本轮当前发言中支持这条记忆的最短原话片段，最多 120 字' },
      importance: { type: 'number', description: '长期影响（0–1），独立于对来源的置信度，缺省 0.75' },
      validUntil: { type: 'string', description: '仅当用户明确给出短期事实的截止时间时使用 ISO 时间' },
    },
    output: {
      schema: { type: 'object', properties: { stored: { type: 'boolean', required: true } }, additionalProperties: false },
      render: () => [],
    },
    async execute({ content, kind, origin, evidence, importance = 0.75, validUntil }, exec) {
      const host = resolveHostContext(exec, currentInput.get(exec?.agent?.session)?.event);
      const fact = content?.trim().replace(/\s+/g, ' ');
      const quote = evidence?.trim();
      if (exec?.signal?.aborted || !host.rawSnippet || isRoutine(host.rawSnippet) || !fact || fact.length > 90 || isRoutine(fact) ||
          !quote || quote.length > 120 || isRoutine(quote) || !host.rawSnippet.includes(quote) ||
          !durableKinds.includes(kind) || !MemoryOrigins.includes(origin) ||
          !Number.isFinite(importance) || importance < 0 || importance > 1) return { stored: false };

      const entry = memory.intake({
        content: fact, kind, scope,
        ...buildIntakeMetadata(host, { content: fact, kind, origin, evidence: quote, importance }),
        ...(validUntil !== undefined && { validUntil }),
      });
      return { stored: !!entry };
    },
  });
}
