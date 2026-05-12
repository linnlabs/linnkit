import { z } from 'zod';

type SerializableJsonValue =
  | string
  | number
  | boolean
  | null
  | SerializableJsonValue[]
  | { [key: string]: SerializableJsonValue };

const SerializableJsonValueSchema: z.ZodType<SerializableJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(SerializableJsonValueSchema),
    z.record(z.string(), SerializableJsonValueSchema),
  ]),
);

const SerializableJsonRecord = z.record(z.string(), SerializableJsonValueSchema);

export const AgentSpecMessageType = z.enum([
  'system_prompt',
  'history_summary',
  'context_injection',
  'user_input',
  'context_before',
  'context_after',
  'document_fragment',
  'task_request',
  'image',
  'thought',
  'final_answer',
  'tool_code',
  'tool_calls',
  'task_completion',
  'tool_output',
]);
export type AgentSpecMessageType = z.infer<typeof AgentSpecMessageType>;

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

export const AgentSpecToolObservationGovernancePolicy = z.object({
  enabled: z.boolean().optional(),
  maxChars: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(),
});
export type AgentSpecToolObservationGovernancePolicy = z.infer<typeof AgentSpecToolObservationGovernancePolicy>;

export const AgentSpecToolOutputPolicy = z.object({
  observationGovernance: AgentSpecToolObservationGovernancePolicy.optional(),
});
export type AgentSpecToolOutputPolicy = z.infer<typeof AgentSpecToolOutputPolicy>;

export const AgentSpecProviderReplayPolicy = z.object({
  provider: z.string().min(1).optional(),
  requiresReasoningDetailsForToolReplay: z.boolean().optional(),
  missingSidecarBehavior: z.enum(['allow', 'degrade_to_text', 'provider_empty_replay_field']).optional(),
});
export type AgentSpecProviderReplayPolicy = z.infer<typeof AgentSpecProviderReplayPolicy>;

export const AgentSpecSummarizationPolicy = z.object({
  triggerThreshold: z.number().min(0).max(1).optional(),
  budgetPercentage: z.number().min(0).max(1).optional(),
  oldestMessagesPercentage: z.number().min(0).max(1).optional(),
  agentId: z.string().min(1).optional(),
  failureBehavior: z.enum(['fail-fast', 'continue-if-within-budget']).optional(),
});
export type AgentSpecSummarizationPolicy = z.infer<typeof AgentSpecSummarizationPolicy>;

export const AgentSpecMustKeepTruncationRule = z.object({
  fenceKind: z.string().min(1),
  maxBudgetFraction: z.number().gt(0).max(1),
  strategyName: z.string().min(1),
});
export type AgentSpecMustKeepTruncationRule = z.infer<typeof AgentSpecMustKeepTruncationRule>;

export const AgentSpecMustKeepPolicy = z.object({
  alwaysKeepTypes: z.array(AgentSpecMessageType).optional(),
  alwaysKeepFenceKinds: z.array(z.string().min(1)).optional(),
  truncationRules: z.array(AgentSpecMustKeepTruncationRule).optional(),
});
export type AgentSpecMustKeepPolicy = z.infer<typeof AgentSpecMustKeepPolicy>;

export const AgentSpecWorkingMemoryPolicy = z.object({
  maxRecentToolInteractions: z.number().int().nonnegative().optional(),
  minToolInteractionsToKeep: z.number().int().nonnegative().optional(),
  toolPairingSearchRange: z.number().int().positive().optional(),
});
export type AgentSpecWorkingMemoryPolicy = z.infer<typeof AgentSpecWorkingMemoryPolicy>;

export const AgentSpecCheckpointPolicy = z.object({
  keepPairsBefore: z.number().int().nonnegative().optional(),
  triggerToolName: z.string().min(1).optional(),
});
export type AgentSpecCheckpointPolicy = z.infer<typeof AgentSpecCheckpointPolicy>;

export const AgentSpecReasoningRetentionPolicy = z.object({
  keepLatestThoughts: z.number().int().nonnegative().optional(),
});
export type AgentSpecReasoningRetentionPolicy = z.infer<typeof AgentSpecReasoningRetentionPolicy>;

export const AgentSpecTokenEstimationPolicy = z.object({
  encoding: z.string().min(1).optional(),
  avgCharsPerToken: z.number().positive().optional(),
  toolCallOverhead: z.number().int().nonnegative().optional(),
});
export type AgentSpecTokenEstimationPolicy = z.infer<typeof AgentSpecTokenEstimationPolicy>;

export const SYSTEM_REMINDER_BUILTIN_TRIGGER_KINDS = [
  'phase-equals',
  'remaining-steps-leq',
  'step-count-modulo',
  'tool-call-streak',
  'budget-warning',
  'agent-has-tool',
] as const;

export const AgentSpecSystemReminderTrigger = z.object({
  kind: z.string().min(1),
  threshold: z.number().nonnegative().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  moduloStep: z.boolean().optional(),
  toolName: z.string().min(1).optional(),
  period: z.number().int().positive().optional(),
  minStep: z.number().int().nonnegative().optional(),
  ratio: z.number().min(0).max(1).optional(),
  config: SerializableJsonRecord.optional(),
});
export type AgentSpecSystemReminderTrigger = z.infer<typeof AgentSpecSystemReminderTrigger>;

export const AgentSpecSystemReminderExtraRule = z.object({
  id: z.string().min(1),
  trigger: AgentSpecSystemReminderTrigger,
  contentTemplate: z.string().min(1),
  contentArgs: SerializableJsonRecord.optional(),
});
export type AgentSpecSystemReminderExtraRule = z.infer<typeof AgentSpecSystemReminderExtraRule>;

export const AgentSpecSystemReminderPolicy = z.object({
  enabledRuleIds: z.array(z.string().min(1)).nullable().optional(),
  disabledRuleIds: z.array(z.string().min(1)).optional(),
  thresholds: z.object({
    toolCallStreak: z.number().int().nonnegative().optional(),
    taskstateReflectionPeriod: z.number().int().positive().optional(),
    budgetWarningRatio: z.number().min(0).max(1).optional(),
    lastStepsHintThreshold: z.number().int().nonnegative().optional(),
  }).optional(),
  extraRules: z.array(AgentSpecSystemReminderExtraRule).optional(),
}).superRefine((value, ctx) => {
  if (value.enabledRuleIds !== undefined && value.enabledRuleIds !== null && value.disabledRuleIds?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['disabledRuleIds'],
      message: 'enabledRuleIds and disabledRuleIds cannot be configured at the same time',
    });
  }
});
export type AgentSpecSystemReminderPolicy = z.infer<typeof AgentSpecSystemReminderPolicy>;

export const AgentSpecContextTracePolicy = z.object({
  enabled: z.boolean().optional(),
  includeMessageIds: z.boolean().optional(),
  includeTokenBreakdown: z.boolean().optional(),
  maxTraceEvents: z.number().int().positive().optional(),
});
export type AgentSpecContextTracePolicy = z.infer<typeof AgentSpecContextTracePolicy>;

export const AgentSpecContextPolicy = z.object({
  profileId: z.string().min(1),
  budget: AgentSpecBudgetPolicy.optional(),
  toolHistory: AgentSpecToolHistoryPolicy.optional(),
  toolOutput: AgentSpecToolOutputPolicy.optional(),
  providerReplay: AgentSpecProviderReplayPolicy.optional(),
  summarization: AgentSpecSummarizationPolicy.optional(),
  mustKeep: AgentSpecMustKeepPolicy.optional(),
  workingMemory: AgentSpecWorkingMemoryPolicy.optional(),
  checkpoint: AgentSpecCheckpointPolicy.optional(),
  reasoningRetention: AgentSpecReasoningRetentionPolicy.optional(),
  tokenEstimation: AgentSpecTokenEstimationPolicy.optional(),
  systemReminder: AgentSpecSystemReminderPolicy.optional(),
  contextTrace: AgentSpecContextTracePolicy.optional(),
});
export type AgentSpecContextPolicy = z.infer<typeof AgentSpecContextPolicy>;

export type AgentSpecContextPolicyInput = Omit<z.input<typeof AgentSpecContextPolicy>, 'profileId'> & {
  profileId?: string;
};

const DEFAULT_CONTEXT_POLICY: Required<AgentSpecContextPolicy> = {
  profileId: 'agent',
  budget: {
    maxTokens: 120000,
    reservedForResponse: 2400,
    workingMemoryBudgetPercentage: 0.7,
  },
  toolHistory: {
    strategy: 'per-run',
    keepLatestToolPairs: 2,
    keepLatestRuns: 1,
    maxInteractionGroups: 12,
    overflowStrategy: 'keep-latest',
    maxPairTokens: 6000,
    maxOutputSummaryTokens: 1000,
  },
  toolOutput: {
    observationGovernance: {
      enabled: true,
      maxChars: 20_000,
      maxLines: 1_200,
    },
  },
  providerReplay: {},
  summarization: {
    triggerThreshold: 0.7,
    budgetPercentage: 0.12,
    oldestMessagesPercentage: 0.75,
    failureBehavior: 'fail-fast',
  },
  mustKeep: {
    alwaysKeepTypes: ['system_prompt', 'user_input'],
    alwaysKeepFenceKinds: [],
    truncationRules: [],
  },
  workingMemory: {
    maxRecentToolInteractions: 2,
    minToolInteractionsToKeep: 2,
    toolPairingSearchRange: 10,
  },
  checkpoint: {
    keepPairsBefore: 2,
    triggerToolName: 'context_checkpoint',
  },
  reasoningRetention: {
    keepLatestThoughts: 1,
  },
  tokenEstimation: {
    encoding: 'cl100k_base',
    avgCharsPerToken: 2.0,
    toolCallOverhead: 50,
  },
  systemReminder: {
    enabledRuleIds: null,
    disabledRuleIds: [],
    thresholds: {
      toolCallStreak: 10,
      taskstateReflectionPeriod: 30,
      budgetWarningRatio: 0.9,
      lastStepsHintThreshold: 0,
    },
    extraRules: [],
  },
  contextTrace: {
    enabled: false,
    includeMessageIds: true,
    includeTokenBreakdown: true,
    maxTraceEvents: 200,
  },
};

/**
 * 创建完整 contextPolicy。
 *
 * 中文备注：
 * - schema 保持 optional，避免现有 host 的 `{ profileId: 'agent' }` 类型大面积变红；
 * - 需要完整默认值时走这个 helper，后续 F1.2/F1.3 的 adapter 与 fallback 会复用它。
 */
export function defineContextPolicy(input: AgentSpecContextPolicyInput = {}): AgentSpecContextPolicy {
  const merged: Required<AgentSpecContextPolicy> = {
    profileId: input.profileId ?? DEFAULT_CONTEXT_POLICY.profileId,
    budget: { ...DEFAULT_CONTEXT_POLICY.budget, ...input.budget },
    toolHistory: { ...DEFAULT_CONTEXT_POLICY.toolHistory, ...input.toolHistory },
    toolOutput: {
      ...DEFAULT_CONTEXT_POLICY.toolOutput,
      ...input.toolOutput,
      observationGovernance: {
        ...DEFAULT_CONTEXT_POLICY.toolOutput.observationGovernance,
        ...input.toolOutput?.observationGovernance,
      },
    },
    providerReplay: { ...DEFAULT_CONTEXT_POLICY.providerReplay, ...input.providerReplay },
    summarization: { ...DEFAULT_CONTEXT_POLICY.summarization, ...input.summarization },
    mustKeep: { ...DEFAULT_CONTEXT_POLICY.mustKeep, ...input.mustKeep },
    workingMemory: { ...DEFAULT_CONTEXT_POLICY.workingMemory, ...input.workingMemory },
    checkpoint: { ...DEFAULT_CONTEXT_POLICY.checkpoint, ...input.checkpoint },
    reasoningRetention: { ...DEFAULT_CONTEXT_POLICY.reasoningRetention, ...input.reasoningRetention },
    tokenEstimation: { ...DEFAULT_CONTEXT_POLICY.tokenEstimation, ...input.tokenEstimation },
    systemReminder: {
      ...DEFAULT_CONTEXT_POLICY.systemReminder,
      ...input.systemReminder,
      thresholds: {
        ...DEFAULT_CONTEXT_POLICY.systemReminder.thresholds,
        ...input.systemReminder?.thresholds,
      },
      extraRules: input.systemReminder?.extraRules ?? DEFAULT_CONTEXT_POLICY.systemReminder.extraRules,
    },
    contextTrace: { ...DEFAULT_CONTEXT_POLICY.contextTrace, ...input.contextTrace },
  };

  return AgentSpecContextPolicy.parse(merged);
}
