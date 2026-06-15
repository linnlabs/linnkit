import type {
  AgentSpec,
  AgentSpecCheckpointPolicy,
  AgentSpecContextPolicy,
  AgentSpecContextTracePolicy,
  AgentSpecProviderReplayPolicy,
  AgentSpecSummarizationPolicy,
  AgentSpecSystemReminderPolicy,
  AgentSpecToolOutputPolicy,
} from '../../contracts';
import {
  DEFAULT_MUST_KEEP_POLICY,
  type MustKeepPolicy,
} from './policies';

export interface AgentContextBuilderConfigOverrides {
  DEFAULT_MAX_TOKENS?: number;
  RESERVED_FOR_RESPONSE?: number;
  WORKING_MEMORY_BUDGET_PERCENTAGE?: number;
  SUMMARIZATION_TRIGGER_THRESHOLD?: number;
  SUMMARY_BUDGET_PERCENTAGE?: number;
  SUMMARY_OLDEST_MESSAGES_PERCENTAGE?: number;
  MAX_THOUGHTS_TO_KEEP?: number;
  TOOL_PAIRING_SEARCH_RANGE?: number;
  MAX_TOOL_PAIR_TOKENS?: number;
  MAX_TOOL_OUTPUT_SUMMARY_TOKENS?: number;
  MIN_TOOL_INTERACTIONS_TO_KEEP?: number;
  MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP?: number;
  MAX_TOOL_INTERACTION_GROUPS_TO_KEEP?: number;
  AVG_CHARS_PER_TOKEN?: number;
  TOOL_CALL_OVERHEAD_TOKENS?: number;
  TOKEN_ENCODING_NAME?: string;
}

export interface AgentSpecPreprocessorOptions {
  toolHistory?: {
    strategy?: 'per-pair' | 'per-run' | 'none';
    retentionMode?: 'drop' | 'compress';
    keepLatestToolPairs?: number;
    keepLatestRuns?: number;
    maxInteractionGroups?: number;
    overflowStrategy?: 'keep-latest' | 'fail-fast';
    maxPairTokens?: number;
    maxOutputSummaryTokens?: number;
  };
  providerReplay?: AgentSpecProviderReplayPolicy;
}

export interface AgentSpecProviderOptions {
  mustKeep?: MustKeepPolicy;
  checkpoint?: AgentSpecCheckpointPolicy;
  summarization?: Pick<AgentSpecSummarizationPolicy, 'agentId' | 'failureBehavior'>;
  contextTrace?: AgentSpecContextTracePolicy;
}

export interface AgentSpecExecutionOptions {
  toolOutput?: AgentSpecToolOutputPolicy;
}

export interface AgentSpecRuntimeOptions {
  contextBuilderConfig: AgentContextBuilderConfigOverrides;
  preprocessorOptions: AgentSpecPreprocessorOptions;
  providerOptions: AgentSpecProviderOptions;
  executionOptions: AgentSpecExecutionOptions;
  systemReminder?: AgentSpecSystemReminderPolicy;
}

/**
 * 把 AgentSpec 的上下文策略转换成 AgentContextManager 能识别的配置覆盖。
 * 注意：profileId 只用于宿主路由，这里不消费。
 */
export function agentSpecToContextBuilderConfig(
  spec: AgentSpec,
): AgentContextBuilderConfigOverrides {
  return contextPolicyToContextBuilderConfig(spec.contextPolicy);
}

export function contextPolicyToContextBuilderConfig(
  policy: AgentSpecContextPolicy,
): AgentContextBuilderConfigOverrides {
  const config: AgentContextBuilderConfigOverrides = {};
  const {
    budget,
    summarization,
    toolHistory,
    workingMemory,
    reasoningRetention,
    tokenEstimation,
  } = policy;

  if (budget?.maxTokens !== undefined) {
    config.DEFAULT_MAX_TOKENS = budget.maxTokens;
  }
  if (budget?.reservedForResponse !== undefined) {
    config.RESERVED_FOR_RESPONSE = budget.reservedForResponse;
  }
  if (budget?.workingMemoryBudgetPercentage !== undefined) {
    config.WORKING_MEMORY_BUDGET_PERCENTAGE = budget.workingMemoryBudgetPercentage;
  }
  if (summarization?.triggerThreshold !== undefined) {
    config.SUMMARIZATION_TRIGGER_THRESHOLD = summarization.triggerThreshold;
  }
  if (summarization?.budgetPercentage !== undefined) {
    config.SUMMARY_BUDGET_PERCENTAGE = summarization.budgetPercentage;
  }
  if (summarization?.oldestMessagesPercentage !== undefined) {
    config.SUMMARY_OLDEST_MESSAGES_PERCENTAGE = summarization.oldestMessagesPercentage;
  }
  if (toolHistory?.maxPairTokens !== undefined) {
    config.MAX_TOOL_PAIR_TOKENS = toolHistory.maxPairTokens;
  }
  if (toolHistory?.maxOutputSummaryTokens !== undefined) {
    config.MAX_TOOL_OUTPUT_SUMMARY_TOKENS = toolHistory.maxOutputSummaryTokens;
  }
  if (toolHistory?.maxInteractionGroups !== undefined) {
    config.MAX_TOOL_INTERACTION_GROUPS_TO_KEEP = toolHistory.maxInteractionGroups;
  }
  if (workingMemory?.maxRecentToolInteractions !== undefined) {
    config.MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP = workingMemory.maxRecentToolInteractions;
  }
  if (workingMemory?.minToolInteractionsToKeep !== undefined) {
    config.MIN_TOOL_INTERACTIONS_TO_KEEP = workingMemory.minToolInteractionsToKeep;
  }
  if (workingMemory?.toolPairingSearchRange !== undefined) {
    config.TOOL_PAIRING_SEARCH_RANGE = workingMemory.toolPairingSearchRange;
  }
  if (reasoningRetention?.keepLatestThoughts !== undefined) {
    config.MAX_THOUGHTS_TO_KEEP = reasoningRetention.keepLatestThoughts;
  }
  if (tokenEstimation?.avgCharsPerToken !== undefined) {
    config.AVG_CHARS_PER_TOKEN = tokenEstimation.avgCharsPerToken;
  }
  if (tokenEstimation?.toolCallOverhead !== undefined) {
    config.TOOL_CALL_OVERHEAD_TOKENS = tokenEstimation.toolCallOverhead;
  }
  if (tokenEstimation?.encoding !== undefined) {
    config.TOKEN_ENCODING_NAME = tokenEstimation.encoding;
  }

  return config;
}

/**
 * 把 contextPolicy.toolHistory 原样转成交给 agent preprocessor registry 的配置。
 */
export function contextPolicyToPreprocessorOptions(
  policy: AgentSpecContextPolicy | undefined,
): AgentSpecPreprocessorOptions {
  const options: AgentSpecPreprocessorOptions = {};

  if (policy?.toolHistory) {
    options.toolHistory = {
      ...policy.toolHistory,
    };
  }

  const providerReplay = pickDefinedProviderReplayOptions(policy?.providerReplay);
  if (providerReplay) {
    options.providerReplay = providerReplay;
  }

  return options;
}

/**
 * 提供给后续 provider registry 重建链路使用。
 * F1.2 只做映射，不在这里创建 provider，避免 shared 层反向依赖 agent profile 实现。
 */
export function contextPolicyToProviderOptions(
  policy: AgentSpecContextPolicy | undefined,
): AgentSpecProviderOptions {
  if (!policy) {
    return {};
  }

  return {
    mustKeep: contextPolicyToMustKeepPolicy(policy),
    checkpoint: policy.checkpoint,
    summarization: pickDefinedSummarizationOptions(policy.summarization),
    contextTrace: policy.contextTrace,
  };
}

export function contextPolicyToMustKeepPolicy(
  policy: AgentSpecContextPolicy | undefined,
): MustKeepPolicy | undefined {
  if (!policy?.mustKeep) {
    return undefined;
  }

  return {
    alwaysKeepTypes: policy.mustKeep.alwaysKeepTypes ?? DEFAULT_MUST_KEEP_POLICY.alwaysKeepTypes,
    alwaysKeepFenceKinds: policy.mustKeep.alwaysKeepFenceKinds ?? DEFAULT_MUST_KEEP_POLICY.alwaysKeepFenceKinds,
    truncationRules: policy.mustKeep.truncationRules ?? DEFAULT_MUST_KEEP_POLICY.truncationRules,
  };
}

export function contextPolicyToSystemReminderOptions(
  policy: AgentSpecContextPolicy | undefined,
): AgentSpecSystemReminderPolicy | undefined {
  return policy?.systemReminder;
}

export function contextPolicyToExecutionOptions(
  policy: AgentSpecContextPolicy | undefined,
): AgentSpecExecutionOptions {
  if (!policy?.toolOutput) {
    return {};
  }

  return {
    toolOutput: {
      ...policy.toolOutput,
      observationGovernance: policy.toolOutput.observationGovernance
        ? { ...policy.toolOutput.observationGovernance }
        : undefined,
    },
  };
}

export function agentSpecToRuntimeOptions(spec: AgentSpec): AgentSpecRuntimeOptions {
  return contextPolicyToRuntimeOptions(spec.contextPolicy);
}

export function contextPolicyToRuntimeOptions(
  policy: AgentSpecContextPolicy,
): AgentSpecRuntimeOptions {
  return {
    contextBuilderConfig: contextPolicyToContextBuilderConfig(policy),
    preprocessorOptions: contextPolicyToPreprocessorOptions(policy),
    providerOptions: contextPolicyToProviderOptions(policy),
    executionOptions: contextPolicyToExecutionOptions(policy),
    systemReminder: contextPolicyToSystemReminderOptions(policy),
  };
}

function pickDefinedProviderReplayOptions(
  providerReplay: AgentSpecProviderReplayPolicy | undefined,
): AgentSpecPreprocessorOptions['providerReplay'] {
  if (!providerReplay) {
    return undefined;
  }
  const result: AgentSpecProviderReplayPolicy = {};
  if (providerReplay.provider !== undefined) {
    result.provider = providerReplay.provider;
  }
  if (providerReplay.requiresReasoningDetailsForToolReplay !== undefined) {
    result.requiresReasoningDetailsForToolReplay = providerReplay.requiresReasoningDetailsForToolReplay;
  }
  if (providerReplay.missingSidecarBehavior !== undefined) {
    result.missingSidecarBehavior = providerReplay.missingSidecarBehavior;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function pickDefinedSummarizationOptions(
  summarization: AgentSpecSummarizationPolicy | undefined,
): AgentSpecProviderOptions['summarization'] {
  if (!summarization) {
    return undefined;
  }
  const result: AgentSpecProviderOptions['summarization'] = {};
  if (summarization.agentId !== undefined) {
    result.agentId = summarization.agentId;
  }
  if (summarization.failureBehavior !== undefined) {
    result.failureBehavior = summarization.failureBehavior;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
