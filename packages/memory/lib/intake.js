import { MemoryOrigins } from './types.js';
import { IntakeWeights } from './schema.js';

const durableKinds = ['preference', 'relationship', 'episodic', 'fact'];
const routine = new Set(['早', '早安', '早上好', '晚安', '晚上好', '你好', '嗨', '哈喽', '在吗',
  '签到', '打卡', '早安打卡', '晚安打卡', '谢谢', '哈哈', 'hello', 'hi', 'good morning', 'good night']);
function isRoutine(text) {
  const words = text.replace(/[\p{P}\p{S}]/gu, '').trim().toLowerCase();
  return !words || routine.has(words);
}

/** 从 QQ 驱动标注的位置取当前发言，排除同一消息内拼接的引用和群历史。 */
export function readConversationInput(message, { includeRoutine = false } = {}) {
  const { qq } = message.source;
  if (!qq || !['direct', 'group'].includes(qq.channel) || !qq.speaker?.trim()) return;
  const block = message.content[0];
  if (block?.type !== 'text') return;
  const text = block.text.slice(qq.start, qq.start + qq.length).trim();
  if (!text || (!includeRoutine && isRoutine(text))) return;
  return { text, speaker: qq.speaker, channel: qq.channel };
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
    },
    output: {
      schema: { type: 'object', properties: { stored: { type: 'boolean', required: true } }, additionalProperties: false },
      render: () => [],
    },
    async execute({ content, kind, origin, evidence, importance = 0.75 }, exec) {
      const input = currentInput.get(exec?.agent?.session);
      const fact = content?.trim().replace(/\s+/g, ' ');
      const quote = evidence?.trim();
      if (exec?.signal?.aborted || !input || !fact || fact.length > 90 || isRoutine(fact) ||
          !quote || quote.length > 120 || isRoutine(quote) || !input.text.includes(quote) ||
          !durableKinds.includes(kind) || !MemoryOrigins.includes(origin) ||
          !Number.isFinite(importance) || importance < 0 || importance > 1) return { stored: false };

      const entry = memory.intake({
        content: fact, kind, scope, importance, confidence: IntakeWeights[origin],
        source: { sessionId: exec.agent.id, channel: 'qq', evidenceText: quote },
        provenance: {
          origin, channel: input.channel, timestamp: input.timestamp,
          speaker: origin === 'model_inference' ? 'model' : input.speaker,
        },
      });
      return { stored: !!entry };
    },
  });
}
