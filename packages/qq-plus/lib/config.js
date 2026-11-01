// 配置定义与 Schema
let Schema = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod.default || mod
} catch {
  // 无宿主 schemastery 时优雅降级
}

export const Config = Schema
  ? Schema.object({
      persona: Schema.union(['auto', 'xiaoman', 'axing'])
        .default('auto')
        .description('角色画像预设：auto（自动依据宿主与 Heart 探测）、xiaoman（小满）、axing（阿醒）'),
      wakeWords: Schema.array(Schema.string())
        .default([])
        .description('自定义群唤醒词列表（留空则采用对应角色默认画像）'),
      heartCadence: Schema.boolean()
        .default(true)
        .description('是否启用基于 Heart Protocol v1 情绪状态的动态打字节奏微调'),
      split: Schema.object({
        enabled: Schema.boolean().default(true).description('是否启用出站短消息断句切分'),
        minChars: Schema.number().default(120).description('短于此字符数不进行断句'),
        targetChars: Schema.number().default(60).description('每段目标期望长度'),
        maxSegments: Schema.number().default(4).description('私聊最多分几段'),
        groupMaxSegments: Schema.number().default(2).description('群聊最多分几段'),
        delayMs: Schema.number().default(600).description('分段发送间隔延迟（毫秒）'),
        protectCode: Schema.boolean().default(true).description('代码块/表格整体保护不切断'),
        skipPrefixes: Schema.array(Schema.string()).default(['🔧', '❌', '⚠️']).description('跳过断句的消息前缀'),
      }).description('出站消息切分参数'),
    })
  : null
