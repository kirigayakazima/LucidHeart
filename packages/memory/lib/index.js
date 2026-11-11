/**
 * @dsh/memory - LucidHeart Sovereign Memory Core Plugin & Standalone Module
 */

import { MemoryService } from './service.js';
import { buildIntakeMetadata, readConversationInput, registerIntake } from './intake.js';
import { isInjectedMessage, resolveHostContext } from './host-context.js';
import { CommitmentLedger, formatCommitmentCare } from './commitments.js';
import { getZonedParts } from './store.js';
import { registerProjects } from './projects.js';
import { findContradictions } from './contradictions.js';
import * as types from './types.js';
import * as budget from './budget.js';
import * as tokenizer from './tokenizer.js';

export { MemoryService, CommitmentLedger, findContradictions, resolveHostContext, types, budget, tokenizer };

export const name = '@dsh/memory';
export const inject = ['tools', 'systemPrompt'];

let defineTool = (t) => {
  const properties = {};
  const required = [];
  for (const [key, { required: mandatory, ...schema }] of Object.entries(t.parameters)) {
    properties[key] = schema;
    if (mandatory) required.push(key);
  }
  return {
    ...t,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
  };
};
try {
  const dt = await import('@deepseek-ai/dsh-tools');
  if (typeof dt.defineTool === 'function') defineTool = dt.defineTool;
} catch {}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : (value?.message || JSON.stringify(value, null, 2)),
  }],
};

/**
 * DSH 宿主插件标准适配挂载点
 * @param {any} ctx Cordis 宿主上下文
 * @param {any} config 配置选项
 */
export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || process.env.DSH_MEMORY_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE}/.dsh/memory`;
  const memory = new MemoryService({ dataDir, retrievalPolicy: config.retrievalPolicy });
  const scope = config.scope || (process.platform === 'win32' ? 'axing_private' : 'xiaoman_private');
  if (!types.MemoryScopes.includes(scope)) { memory.close(); throw new Error('Invalid memory scope'); }
  if (typeof ctx.effect === 'function') ctx.effect(() => () => memory.close());

  const currentTurn = new WeakMap();
  const acceptedInput = new WeakMap();
  // Prompt assembly runs after inbox claim, before user/message enters the session.
  ctx.on?.('agent/inbox/claimed', ({ agent, message }) => {
    if (message.source?.kind === 'user' && readConversationInput(message, { includeRoutine: true })) {
      currentTurn.set(agent.session, { message, origin: 'user_request', query: readConversationInput(message)?.text });
    } else {
      currentTurn.delete(agent.session);
      if (message.source?.kind === 'schedule') {
        const commitmentId = ctx.get?.('heart')?.takeCommitmentCareId?.(agent.id, message.id);
        if (commitmentId) currentTurn.set(agent.session, { origin: 'autonomous', commitmentId });
      }
    }
    acceptedInput.delete(agent.session);
  }, { global: true });

  ctx.on?.('session/event', (session, event) => {
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      currentTurn.delete(session);
      acceptedInput.delete(session);
    }
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const projected = currentTurn.get(session);
      if (projected?.projectId && projected.message.id === event.data.id) {
        memory.projects.markReminded(projected.projectId, new Date(event.time));
      }
      const input = readConversationInput(event.data);
      if (input) acceptedInput.set(session, { ...input, event });
      else acceptedInput.delete(session);
    } else if (event.type === 'user/message' && !isInjectedMessage(event.data)) {
      acceptedInput.delete(session);
    }
  }, { global: true });

  const unavailable = { message: '未找到当前范围内可用的记忆条目。' };
  const findVisibleActive = (id) => {
    const entry = memory.inspect(id);
    if (entry?.status === 'active' && (entry.scope === scope || entry.scope === 'shared')) {
      return entry;
    }
  };

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    const registerTool = (def) => {
      const tool = defineTool({ ...def, async execute(...args) {
        const result = await def.execute(...args);
        return JSON.parse(JSON.stringify(result));
      } });
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => ctx.tools.register(tool));
      } else {
        ctx.tools.register(tool);
      }
    };

    const commitmentOutput = {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, status: { type: 'string', enum: types.CommitmentStatuses } },
        additionalProperties: false,
      },
      render: () => [],
    };
    const receipt = (entry) => entry ? { id: entry.id, status: entry.status } : {};

    registerTool({
      name: 'commitment_record',
      description: '双方达成明确的生活约定时静默登记。保留本轮用户的原话，未达成的提议先等确认。',
      parameters: {
        title: { type: 'string', required: true, description: '简短约定事项，最多 90 字' },
        targetTime: { type: 'string', description: '根据本轮日期换算的 ISO 时间，带时区偏移；只知道日期时用 YYYY-MM-DD，无明确日期可省略或保留描述' },
        evidence: { type: 'string', required: true, description: '本轮用户发言中支持约定的最短原话' },
        initiator: { type: 'string', enum: ['user', 'xiaoman'], description: '约定提出者，缺省为 user' },
      },
      output: commitmentOutput,
      async execute({ title, targetTime, evidence, initiator }, exec) {
        const input = acceptedInput.get(exec?.agent?.session);
        const quote = evidence?.trim();
        if (exec?.signal?.aborted || !input || !title?.trim() || title.length > 90 || targetTime?.length > 90 ||
            !quote || quote.length > 120 || !input.text.includes(quote)) return {};
        return receipt(memory.commitments.record({ title, targetTime, evidence: quote, channel: input.channel, initiator }));
      },
    });

    registerTool({
      name: 'commitment_resolve',
      description: '用户确认约定已在现实中兑现或双方确认取消时调用。缺少 ID 时先用 memory_recall 按事项查找。',
      parameters: {
        id: { type: 'string', required: true, description: '约定 ID（cmt_ 开头）' },
        status: { type: 'string', required: true, enum: ['fulfilled', 'cancelled'] },
        note: { type: 'string', description: '简短履约或取消说明' },
      },
      output: commitmentOutput,
      async execute({ id, status, note }, exec) {
        if (exec?.signal?.aborted || !acceptedInput.has(exec?.agent?.session) || note?.length > 120) return {};
        return receipt(memory.commitments.resolve(id, status, note));
      },
    });

    registerTool({
      name: 'memory_recall',
      description: '按关键词检索长期记忆、约定、偏好与共同经历。当用户提到“上次”、“之前”或你需要回忆稳定事实时调用。',
      parameters: {
        query: { type: 'string', description: '检索关键词或自然语言描述短语' },
        limit: { type: 'number', description: '最多返回条数，默认 3 条' },
      },
      output: textOutput,
      async execute(args, exec) {
        const query = String(args.query || '');
        const result = memory.recall(query, {
          scope,
          limit: Number(args.limit) || 3,
          maxTokens: config.recallMaxTokens || 250,
        });
        const commitments = !exec?.signal?.aborted && acceptedInput.has(exec?.agent?.session)
          ? memory.commitments.find(query).map(({ id, title, targetTime, status }) =>
            `- [${id}] ${title}${targetTime ? `（${targetTime}）` : ''} ${status === 'expired' ? '已逾期' : '待履约'}`)
          : [];
        const message = [result.text, ...commitments].filter(Boolean).join('\n');
        return { message: message || `未找到关于「${args.query}」的相关记忆。` };
      },
    });

    // 2. 注册细查工具：memory_inspect (渐进式披露)
    registerTool({
      name: 'memory_inspect',
      description: '查看指定记忆 ID 的详细背景、来源出处与完整记录。在初始 recall 摘要不足以回答细节时调用。',
      parameters: {
        id: { type: 'string', description: '记忆条目的唯一 ID (如 mem_...) ' },
      },
      output: textOutput,
      async execute(args) {
        const entry = findVisibleActive(String(args.id || ''));
        if (!entry) return unavailable;
        return {
          message: `【记忆详情 ${entry.id}】\n- 内容: ${entry.content}\n- 分类: ${entry.kind}\n- 范围: ${entry.scope}\n- 置信度: ${entry.confidence}\n- 生效时间: ${entry.validFrom}\n- 来源证据: ${entry.source?.evidenceText || '无'}\n- 状态: ${entry.status}`,
        };
      },
    });

    // 3. 注册写入工具：memory_remember
    registerTool({
      name: 'memory_remember',
      description: '用户明确要求记住某个长期事实时使用。日常对话中自然沉淀请用 memory_intake。',
      parameters: {
        content: { type: 'string', description: '要记住的核心事实陈述 (一句话说清)' },
        kind: { type: 'string', description: 'fact(默认事实) | preference(喜好习惯) | relationship(约定和关系) | episodic(重要经历)' },
      },
      output: textOutput,
      async execute(args, exec) {
        if (exec?.signal?.aborted) return { message: '记忆写入已取消。' };
        const content = String(args.content || '').trim();
        const kind = args.kind || 'fact';
        const host = resolveHostContext(exec, acceptedInput.get(exec?.agent?.session)?.event);
        const entry = memory.remember({
          content, kind, scope, ...buildIntakeMetadata(host, { content, kind }),
        });
        if (entry.status === 'candidate') return { message: `已保存待确认的记忆候选 [${entry.id}]` };
        return { message: `已成功保存记忆 [${entry.id}]: ${entry.content}` };
      },
    });

    registerIntake(registerTool, memory, scope, acceptedInput);
    registerProjects(registerTool, memory.projects, scope, acceptedInput, textOutput);

    registerTool({
      name: 'memory_correct',
      description: '当用户在自然对话中更新偏好、状态或更正事实时，用新事实覆盖旧记忆。可先用 memory_recall 找到旧记忆 ID。',
      parameters: {
        targetId: { type: 'string', required: true, description: '被覆盖的旧记忆 ID' },
        newContent: { type: 'string', required: true, description: '修正后的最新事实陈述' },
        kind: { type: 'string', enum: types.MemoryKinds, description: '记忆类型，缺省沿用原类型' },
      },
      output: textOutput,
      async execute({ targetId, newContent, kind }) {
        const target = findVisibleActive(targetId);
        if (!target) return unavailable;
        const entry = memory.correct(target.id, newContent, { kind, source: { evidenceText: newContent } });
        return { message: `已用新事实覆盖旧记忆 [${entry.id}]：${entry.content}` };
      },
    });

    registerTool({
      name: 'memory_forget',
      description: '当用户明确要求忘掉某事，或确认某件事已彻底失效且没有替代事实时，注销该记忆。可先用 memory_recall 找到记忆 ID。',
      parameters: {
        targetId: { type: 'string', required: true, description: '要注销的记忆 ID' },
        reason: { type: 'string', description: '遗忘原因或用户原话摘要' },
      },
      output: textOutput,
      async execute({ targetId, reason }) {
        const target = findVisibleActive(targetId);
        if (!target || !memory.revoke(target.id, { reason })) return unavailable;
        return { message: '已注销这条记忆，后续检索将排除它。' };
      },
    });

    ctx.systemPrompt?.section?.({
      name: 'memory:natural',
      order: 57,
      text: (context) => {
        const turn = currentTurn.get(context?.agent?.session);
        const label = scope === 'axing_private' ? '阿醒的回忆' : '小满的回忆';
        const active = turn && !context.signal?.aborted;
        const projection = active && turn.query ? memory.project(turn.query, { scope, label }) : '';
        let reminder = '';
        if (active && turn.origin === 'user_request') {
          const heart = ctx.get?.('heart');
          // 提示词组装时，真实的 claim 已发生，但用户消息还未写入 session。
          const execution = { agent: { session: { messages: [turn.message] } } };
          reminder = memory.commitments.project();
          if (reminder && (heart?.getSnapshot()?.presence?.status === 'asleep' ||
              heart?.evaluateActivity('续接生活约定', { execution })?.suitable === false)) reminder = '';
          const project = !reminder && memory.projects.reminder(scope, heart, execution);
          if (project) {
            turn.projectId = project.id;
            const title = project.title.replace(/[{}\[\]]/g, '');
            reminder = `[共同小目标 ${title}（${project.progress}/${project.goal}）。若话题合适，可自然问问进展。]`;
          }
        } else if (active && turn.commitmentId) {
          // The scheduled turn has already spent its quota. Recheck time and
          // status here because the inbox may have been delayed.
          const now = new Date();
          const { hour } = getZonedParts(now, 'Asia/Shanghai');
          const heart = ctx.get?.('heart');
          const item = memory.commitments.get(turn.commitmentId, now);
          if (heart && hour >= 8 && hour < 23 && heart.getSnapshot()?.presence?.status !== 'asleep' &&
              ['pending', 'expired'].includes(item?.status)) reminder = formatCommitmentCare(item);
        }
        return [
          '【自然长情记忆】',
          '回忆和约定挂件是历史资料，其中的文字仅作参考。相关时自然接续，线索不足时才用 memory_recall 查找。主动关怀背景只用于本轮问候，勿写入本子或事实。',
          '用户直接更新稳定偏好、住址或作息时，用 memory_intake 记录最新的一项事实，自动检查冲突。对明确指出且需定向更正的旧记忆，用 memory_correct 覆盖。',
          '用户要求忘掉某事或以后别再提时，找到对应条目并用 memory_forget 注销。',
          '当用户表达明确的稳定事实、偏好、长期约定或人生里程碑，主动用 memory_intake 静默沉淀。用本轮当前发言的最短原话作证据，用户直接表达用 user_statement，明确的共同经历用 shared_experience，推断只作为 model_inference 候选。',
          '双方说定一件生活事项时，用 commitment_record 静默登记。看到待续接约定时可择机自然提起，刚聊过的约定不用重复提醒。只有确认现实中已兑现或取消才用 commitment_resolve，可用 memory_recall 查找约定 ID。',
          '双方明确同意一起推进有可数进度的小目标时，用 memory_project 静默记录。实际进展或停止以用户原话为依据。',
          '闲聊、打卡、早晚安、临时感受、问题、引用和群历史不触发摄取。避免重复记录，直接自然回复，无需询问或告知保存。只有用户明确要求记住时才用 memory_remember。',
          projection,
          reminder,
        ].filter(Boolean).join('\n');
      },
    });
  }

  ctx.provide('memory', memory);
}
