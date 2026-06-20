import { z } from 'zod';

/**
 * Token 计数来源：每个 token 数字都必须说明从哪里来，避免把估算当成账单事实。
 */
export const TokenCountSource = z.enum([
  'local-estimate',
  'provider-preflight-count',
  'provider-response-usage',
  'host-supplied',
  'test-fixture',
]);
export type TokenCountSource = z.infer<typeof TokenCountSource>;

/**
 * Token 计数可信度：只有 actual 才能进入真实计费与后续校准。
 */
export const TokenCountConfidence = z.enum([
  'estimate',
  'provider-estimate',
  'actual',
]);
export type TokenCountConfidence = z.infer<typeof TokenCountConfidence>;

/**
 * 当前调用 route 的 token 能力声明。
 *
 * 这些能力由 host 的 model catalog 声明；linnkit 不内置 provider 到能力的映射表。
 */
export const TokenRouteCapabilities = z.object({
  supportsRemoteTokenCount: z.boolean().optional(),
  supportsResponseUsage: z.boolean().optional(),
  supportsImageInput: z.boolean().optional(),
  supportsCachedInputBilling: z.boolean().optional(),
  supportsReasoningTokens: z.boolean().optional(),
});
export type TokenRouteCapabilities = z.infer<typeof TokenRouteCapabilities>;

/**
 * Token 计算路由：同一个模型经不同 gateway 时，计数能力可能完全不同。
 */
export const TokenRoute = z.object({
  providerId: z.string().describe('host 侧 provider 标识：openai / anthropic / openrouter / siliconflow / zai ...'),
  baseURL: z.string().optional().describe('中转平台或私有 endpoint；用于区分同名模型的不同 route'),
  modelId: z.string().describe('host 侧模型 id'),
  providerModelId: z.string().optional().describe('provider 实际模型名（与 host modelId 可能不同）'),
  capabilities: TokenRouteCapabilities.optional(),
});
export type TokenRoute = z.infer<typeof TokenRoute>;

const tokenCount = z.number().int().nonnegative();

/**
 * 归一化后的 LLM 用量。
 *
 * 关键约束：
 * - inputTokens 是非缓存普通输入 token，不含 cacheRead/cacheWrite，避免重复计费。
 * - reasoning/cache 字段用 optional 表达“未上报”和“明确为 0”的差异。
 * - totalTokens 可缺失，也不保证等于各分项之和。
 * - rawUsage 仅供审计；业务逻辑应依赖 canonical 字段。
 */
export const CanonicalLlmUsage = z.object({
  inputTokens: tokenCount.describe('非缓存普通输入 token'),
  outputTokens: tokenCount.describe('输出 token'),
  reasoningTokens: tokenCount.optional().describe('推理 token；undefined=未单列，0=报告为 0'),
  cacheReadTokens: tokenCount.optional().describe('缓存命中读取 token'),
  cacheWriteTokens: tokenCount.optional().describe('缓存写入 token'),
  totalTokens: tokenCount.optional().describe('provider 报告的总量；可缺失，且不保证等于各项之和'),
  source: TokenCountSource,
  confidence: TokenCountConfidence,
  rawUsage: z.unknown().optional().describe('原始 provider usage，仅供审计'),
});
export type CanonicalLlmUsage = z.infer<typeof CanonicalLlmUsage>;
