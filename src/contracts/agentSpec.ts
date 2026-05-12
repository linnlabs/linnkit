import { z } from 'zod';

const JsonRecord = z.record(z.string(), z.unknown());

/**
 * 工具参数 schema 在 AgentSpec 里是可序列化契约，不是运行时 zod 对象。
 * 这里主动拦截 zod-like 对象，避免把 `z.any()` 一类实现细节混进协议层。
 */
const ToolArgsSchemaSpec = JsonRecord.superRefine((value, ctx) => {
  const parse = value['parse'];
  const safeParse = value['safeParse'];
  const definition = value['_def'];
  if (typeof parse === 'function' && typeof safeParse === 'function' && definition !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'argsSchema must be a serializable record, not a runtime zod schema',
    });
  }
});

export const AgentCapability = z.string().min(1);
export type AgentCapability = z.infer<typeof AgentCapability>;

export const ToolBindingSpec = z.object({
  toolId: z.string().min(1),
  bindingId: z.string().min(1).optional(),
  argsSchema: ToolArgsSchemaSpec.optional(),
  config: JsonRecord.optional(),
  metadata: JsonRecord.optional(),
});
export type ToolBindingSpec = z.infer<typeof ToolBindingSpec>;

export const AgentSpecBudgetPolicy = z.object({
  maxTokens: z.number().int().positive().optional(),
  reservedForResponse: z.number().int().nonnegative().optional(),
  workingMemoryBudgetPercentage: z.number().min(0).max(1).optional(),
});
export type AgentSpecBudgetPolicy = z.infer<typeof AgentSpecBudgetPolicy>;

export const AgentSpecToolHistoryPolicy = z.object({
  strategy: z.enum(['per-pair', 'per-run', 'none']).optional(),
  keepLatestToolPairs: z.number().int().nonnegative().optional(),
  keepLatestRuns: z.number().int().nonnegative().optional(),
  maxInteractionGroups: z.number().int().nonnegative().optional(),
  overflowStrategy: z.enum(['keep-latest', 'fail-fast']).optional(),
  maxPairTokens: z.number().int().nonnegative().optional(),
  maxOutputSummaryTokens: z.number().int().nonnegative().optional(),
});
export type AgentSpecToolHistoryPolicy = z.infer<typeof AgentSpecToolHistoryPolicy>;

export const AgentSpecSummarizationPolicy = z.object({
  triggerThreshold: z.number().min(0).max(1).optional(),
  budgetPercentage: z.number().min(0).max(1).optional(),
  oldestMessagesPercentage: z.number().min(0).max(1).optional(),
});
export type AgentSpecSummarizationPolicy = z.infer<typeof AgentSpecSummarizationPolicy>;

export const AgentSpecContextPolicy = z.object({
  profileId: z.string().min(1),
  budget: AgentSpecBudgetPolicy.optional(),
  toolHistory: AgentSpecToolHistoryPolicy.optional(),
  summarization: AgentSpecSummarizationPolicy.optional(),
});
export type AgentSpecContextPolicy = z.infer<typeof AgentSpecContextPolicy>;

export const AgentSpecModelHints = z.object({
  preferredProviders: z.array(z.string().min(1)).optional(),
  preferredModels: z.array(z.string().min(1)).optional(),
  fallbackChain: z.array(z.string().min(1)).optional(),
});
export type AgentSpecModelHints = z.infer<typeof AgentSpecModelHints>;

export const AgentSpecAuditConfig = z.object({
  redactionLevel: z.enum(['none', 'standard', 'strict']).optional(),
  pii: z.boolean().optional(),
});
export type AgentSpecAuditConfig = z.infer<typeof AgentSpecAuditConfig>;

export const AgentSpec = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  role: z.string().optional(),
  description: z.string().optional(),
  capabilities: z.array(AgentCapability),
  tools: z.array(ToolBindingSpec),
  contextPolicy: AgentSpecContextPolicy,
  modelHints: AgentSpecModelHints.optional(),
  audit: AgentSpecAuditConfig.optional(),
  metadata: JsonRecord.optional(),
});
export type AgentSpec = z.infer<typeof AgentSpec>;
