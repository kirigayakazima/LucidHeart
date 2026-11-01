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
  const params = t.parameters || {};
  return {
    ...t,
    parameters: params.type === 'object' ? params : {
      type: 'object',
      properties: params,
    },
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
 * DSH 宿主插件标准适配挂载点 (薄适配器，约 80 行代码)
 * @param {any} ctx Cordis 宿主上下文
 * @param {any} config 配置选项
 */
export function apply(ctx, config = {}) {
  const dataDir = config.dataDir || process.env.DSH_MEMORY_DATA_DIR || `${process.env.HOME || process.env.USERPROFILE}/.dsh/memory`;
  const memory = new MemoryService({ dataDir });

  // 1. 注册核心工具：memory_recall
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
        const entry = memory.inspect(String(args.id || ''));
        if (!entry) return { message: `未找到 ID 为 ${args.id} 的记忆条目。` };
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
        kind: { type: 'string', description: 'fact(默认事实) | preference(喜好习惯) | relationship(约定)' },
      },
      output: textOutput,
      async execute(args) {
        const entry = memory.remember({
          content: String(args.content || ''),
          kind: args.kind || 'fact',
          scope: config.scope || 'xiaoman_private',
          confidence: 1.0,
          confirmed: true,
        });
        return { message: `已成功保存记忆 [${entry.id}]: ${entry.content}` };
      },
    });
  }

  // 4. 挂载到宿主服务
  ctx.provide('memory', memory);
}
