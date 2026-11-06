/**
 * @dsh/memory - LucidHeart Sovereign Memory Core Plugin & Standalone Module
 */

import { MemoryService } from './service.js';
import * as types from './types.js';
import * as budget from './budget.js';
import * as tokenizer from './tokenizer.js';

export { MemoryService, types, budget, tokenizer };

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
  const memory = new MemoryService({ dataDir });
  const scope = config.scope || (process.platform === 'win32' ? 'axing_private' : 'xiaoman_private');
  if (!types.MemoryScopes.includes(scope)) { memory.close(); throw new Error('Invalid memory scope'); }
  if (typeof ctx.effect === 'function') ctx.effect(() => () => memory.close());

  const unavailable = { message: '未找到当前范围内可用的记忆条目。' };
  const findVisibleActive = (id) => {
    const entry = memory.inspect(id);
    if (entry?.status === 'active' && (entry.scope === scope || entry.scope === 'shared')) {
      return entry;
    }
  };

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    const registerTool = (def) => {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => ctx.tools.register(defineTool(def)));
      } else {
        ctx.tools.register(defineTool(def));
      }
    };

    registerTool({
      name: 'memory_recall',
      description: '按关键词检索长期记忆、约定、偏好与共同经历。当用户提到“上次”、“之前”或你需要回忆稳定事实时调用。',
      parameters: {
        query: { type: 'string', description: '检索关键词或自然语言描述短语' },
        limit: { type: 'number', description: '最多返回条数，默认 3 条' },
      },
      output: textOutput,
      async execute(args) {
        const result = memory.recall(String(args.query || ''), {
          scope,
          limit: Number(args.limit) || 3,
          maxTokens: config.recallMaxTokens || 250,
        });
        if (result.count === 0) {
          return { message: `未找到关于「${args.query}」的相关记忆。` };
        }
        return { message: result.text };
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
      description: '记录关于对方、世界或两人的长期事实与重要约定。仅用于值得长久记住的内容，勿记录临时闲聊。',
      parameters: {
        content: { type: 'string', description: '要记住的核心事实陈述 (一句话说清)' },
        kind: { type: 'string', description: 'fact(默认事实) | preference(喜好习惯) | relationship(约定和关系) | episodic(重要经历)' },
      },
      output: textOutput,
      async execute(args) {
        const entry = memory.remember({
          content: String(args.content || ''),
          kind: args.kind || 'fact',
          scope,
          confidence: 1.0,
          confirmed: true,
        });
        return { message: `已成功保存记忆 [${entry.id}]: ${entry.content}` };
      },
    });

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
      text: () => [
        '【自然长情记忆】',
        '谈到过往生活、重要约定或需要偏好背景时，先用 memory_recall 查找已有记忆。',
        '用户更正事实或更新偏好、住址、生活习惯时，检索旧条目并用 memory_correct 覆盖，切勿用 memory_remember 另存一条相互矛盾的事实。',
        '用户要求忘掉某事或以后别再提时，找到对应条目并用 memory_forget 注销。',
        '只记核心偏好、人生经历与重要生活约定，略过日常闲聊。根据自然对话理解用户的意图。',
      ].join('\n'),
    });
  }

  ctx.provide('memory', memory);
}
