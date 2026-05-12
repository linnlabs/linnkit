import type {
  AgentSpec,
  AgentSpecContextPolicy,
} from '../../contracts';

export interface AgentContextBuilderConfigOverrides {
  DEFAULT_MAX_TOKENS?: number;
  RESERVED_FOR_RESPONSE?: number;
  WORKING_MEMORY_BUDGET_PERCENTAGE?: number;
  SUMMARIZATION_TRIGGER_THRESHOLD?: number;
  SUMMARY_BUDGET_PERCENTAGE?: number;
  SUMMARY_OLDEST_MESSAGES_PERCENTAGE?: number;
}

export interface AgentSpecPreprocessorOptions {
  toolHistory?: {
    strategy?: 'per-pair' | 'per-run' | 'none';
    keepLatestToolPairs?: number;
    keepLatestRuns?: number;
    maxInteractionGroups?: number;
    overflowStrategy?: 'keep-latest' | 'fail-fast';
    maxPairTokens?: number;
    maxOutputSummaryTokens?: number;
  };
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
  const { budget, summarization } = policy;

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

  return config;
}

/**
 * 把 contextPolicy.toolHistory 原样转成交给 agent preprocessor registry 的配置。
 */
export function contextPolicyToPreprocessorOptions(
  policy: AgentSpecContextPolicy | undefined,
): AgentSpecPreprocessorOptions {
  if (!policy?.toolHistory) {
    return {};
  }

  return {
    toolHistory: {
      ...policy.toolHistory,
    },
  };
}
