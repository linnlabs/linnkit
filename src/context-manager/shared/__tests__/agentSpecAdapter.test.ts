import { describe, expect, it } from 'vitest';
import { defineContextPolicy } from '../../../contracts';
import {
  agentSpecToRuntimeOptions,
  contextPolicyToContextBuilderConfig,
  contextPolicyToExecutionOptions,
  contextPolicyToPreprocessorOptions,
  contextPolicyToProviderOptions,
  contextPolicyToSystemReminderOptions,
} from '../agentSpecAdapter';
import { mergeContextPolicy } from '../contextPolicyMerge';

describe('agentSpecAdapter', () => {
  it('maps budget, summarization, working memory, reasoning and token estimation into builder config', () => {
    const policy = defineContextPolicy({
      budget: {
        maxTokens: 32000,
        reservedForResponse: 1024,
        workingMemoryBudgetPercentage: 0.6,
      },
      summarization: {
        triggerThreshold: 0.8,
        budgetPercentage: 0.15,
        oldestMessagesPercentage: 0.5,
      },
      toolHistory: {
        maxInteractionGroups: 8,
        maxPairTokens: 4096,
        maxOutputSummaryTokens: 512,
      },
      workingMemory: {
        maxRecentToolInteractions: 4,
        minToolInteractionsToKeep: 1,
        toolPairingSearchRange: 16,
      },
      reasoningRetention: {
        keepLatestThoughts: 3,
      },
      tokenEstimation: {
        encoding: 'o200k_base',
        avgCharsPerToken: 1.8,
        toolCallOverhead: 70,
      },
    });

    expect(contextPolicyToContextBuilderConfig(policy)).toEqual({
      DEFAULT_MAX_TOKENS: 32000,
      RESERVED_FOR_RESPONSE: 1024,
      WORKING_MEMORY_BUDGET_PERCENTAGE: 0.6,
      SUMMARIZATION_TRIGGER_THRESHOLD: 0.8,
      SUMMARY_BUDGET_PERCENTAGE: 0.15,
      SUMMARY_OLDEST_MESSAGES_PERCENTAGE: 0.5,
      MAX_TOOL_PAIR_TOKENS: 4096,
      MAX_TOOL_OUTPUT_SUMMARY_TOKENS: 512,
      MAX_TOOL_INTERACTION_GROUPS_TO_KEEP: 8,
      MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP: 4,
      MIN_TOOL_INTERACTIONS_TO_KEEP: 1,
      TOOL_PAIRING_SEARCH_RANGE: 16,
      MAX_THOUGHTS_TO_KEEP: 3,
      AVG_CHARS_PER_TOKEN: 1.8,
      TOOL_CALL_OVERHEAD_TOKENS: 70,
      TOKEN_ENCODING_NAME: 'o200k_base',
    });
  });

  it('maps toolHistory into preprocessor options without unrelated policy groups', () => {
    const policy = defineContextPolicy({
      toolHistory: {
        strategy: 'per-pair',
        retentionMode: 'compress',
        keepLatestToolPairs: 0,
        overflowStrategy: 'fail-fast',
      },
      providerReplay: {
        provider: 'system_default',
        requiresReasoningDetailsForToolReplay: true,
        missingSidecarBehavior: 'provider_empty_replay_field',
      },
      workingMemory: {
        maxRecentToolInteractions: 5,
      },
    });

    expect(contextPolicyToPreprocessorOptions(policy)).toEqual({
      toolHistory: expect.objectContaining({
        strategy: 'per-pair',
        retentionMode: 'compress',
        keepLatestToolPairs: 0,
        overflowStrategy: 'fail-fast',
      }),
      providerReplay: {
        provider: 'system_default',
        requiresReasoningDetailsForToolReplay: true,
        missingSidecarBehavior: 'provider_empty_replay_field',
      },
    });
  });

  it('does not override model-derived provider replay policy when providerReplay is empty by default', () => {
    const policy = defineContextPolicy({
      toolHistory: {
        strategy: 'per-run',
      },
    });

    expect(contextPolicyToPreprocessorOptions(policy).providerReplay).toBeUndefined();
  });

  it('maps provider and system reminder options separately', () => {
    const policy = defineContextPolicy({
      mustKeep: {
        alwaysKeepFenceKinds: ['project-context'],
      },
      checkpoint: {
        keepPairsBefore: 4,
      },
      summarization: {
        agentId: 'history_compression',
        failureBehavior: 'continue-if-within-budget',
      },
      contextTrace: {
        enabled: true,
      },
      systemReminder: {
        disabledRuleIds: ['budget-warning'],
      },
    });

    expect(contextPolicyToProviderOptions(policy)).toEqual({
      mustKeep: expect.objectContaining({
        alwaysKeepFenceKinds: ['project-context'],
      }),
      checkpoint: expect.objectContaining({
        keepPairsBefore: 4,
      }),
      summarization: {
        agentId: 'history_compression',
        failureBehavior: 'continue-if-within-budget',
      },
      contextTrace: expect.objectContaining({
        enabled: true,
      }),
    });
    expect(contextPolicyToSystemReminderOptions(policy)).toEqual(expect.objectContaining({
      disabledRuleIds: ['budget-warning'],
    }));
  });

  it('returns all runtime option groups for an AgentSpec', () => {
    const runtimeOptions = agentSpecToRuntimeOptions({
      id: 'agent',
      version: '0.1.0',
      capabilities: [],
      tools: [],
      contextPolicy: defineContextPolicy({
        toolOutput: {
          observationGovernance: {
            enabled: true,
            maxChars: 48000,
            maxLines: 2400,
          },
        },
        contextTrace: {
          enabled: true,
        },
      }),
    });

    expect(runtimeOptions.contextBuilderConfig.DEFAULT_MAX_TOKENS).toBe(232000);
    expect(runtimeOptions.preprocessorOptions.toolHistory?.strategy).toBe('per-run');
    expect(runtimeOptions.preprocessorOptions.toolHistory?.retentionMode).toBe('drop');
    expect(runtimeOptions.providerOptions.contextTrace?.enabled).toBe(true);
    expect(runtimeOptions.executionOptions.toolOutput?.observationGovernance?.maxChars).toBe(48000);
    expect(runtimeOptions.systemReminder?.thresholds?.toolCallStreak).toBe(10);
  });

  it('maps toolOutput into execution options for runtime tool nodes', () => {
    const policy = defineContextPolicy({
      toolOutput: {
        observationGovernance: {
          enabled: false,
          maxChars: 1024,
          maxLines: 80,
        },
      },
    });

    expect(contextPolicyToExecutionOptions(policy)).toEqual({
      toolOutput: {
        observationGovernance: {
          enabled: false,
          maxChars: 1024,
          maxLines: 80,
        },
      },
    });
  });
});

describe('mergeContextPolicy', () => {
  it('merges framework default, host fallback and agent spec by field priority', () => {
    const merged = mergeContextPolicy({
      frameworkDefault: {
        budget: {
          maxTokens: 10000,
          reservedForResponse: 1000,
        },
        toolHistory: {
          strategy: 'per-pair',
          keepLatestToolPairs: 1,
        },
      },
      hostFallback: {
        budget: {
          reservedForResponse: 1500,
        },
        toolHistory: {
          keepLatestRuns: 2,
        },
        toolOutput: {
          observationGovernance: {
            maxChars: 20000,
            maxLines: 1200,
          },
        },
        providerReplay: {
          requiresReasoningDetailsForToolReplay: true,
          missingSidecarBehavior: 'degrade_to_text',
        },
      },
      agentSpec: {
        budget: {
          maxTokens: 20000,
        },
        toolOutput: {
          observationGovernance: {
            maxLines: 400,
          },
        },
        providerReplay: {
          missingSidecarBehavior: 'allow',
        },
      },
    });

    expect(merged.budget?.maxTokens).toBe(20000);
    expect(merged.budget?.reservedForResponse).toBe(1500);
    expect(merged.toolHistory?.strategy).toBe('per-pair');
    expect(merged.toolHistory?.keepLatestToolPairs).toBe(1);
    expect(merged.toolHistory?.keepLatestRuns).toBe(2);
    expect(merged.toolOutput?.observationGovernance?.maxChars).toBe(20000);
    expect(merged.toolOutput?.observationGovernance?.maxLines).toBe(400);
    expect(merged.providerReplay?.requiresReasoningDetailsForToolReplay).toBe(true);
    expect(merged.providerReplay?.missingSidecarBehavior).toBe('allow');
  });

  it('replaces arrays instead of concatenating them', () => {
    const merged = mergeContextPolicy({
      hostFallback: {
        mustKeep: {
          alwaysKeepFenceKinds: ['host-fence'],
          truncationRules: [
            {
              fenceKind: 'host-fence',
              maxBudgetFraction: 0.2,
              strategyName: 'host-truncate',
            },
          ],
        },
      },
      agentSpec: {
        mustKeep: {
          alwaysKeepFenceKinds: ['agent-fence'],
        },
      },
    });

    expect(merged.mustKeep?.alwaysKeepFenceKinds).toEqual(['agent-fence']);
    expect(merged.mustKeep?.truncationRules).toEqual([
      {
        fenceKind: 'host-fence',
        maxBudgetFraction: 0.2,
        strategyName: 'host-truncate',
      },
    ]);
  });

  it('merges system reminder thresholds field-by-field while replacing extraRules arrays', () => {
    const merged = mergeContextPolicy({
      hostFallback: {
        systemReminder: {
          thresholds: {
            toolCallStreak: 5,
            budgetWarningRatio: 0.85,
          },
          extraRules: [
            {
              id: 'host-rule',
              trigger: { kind: 'tool-call-streak', threshold: 5 },
              contentTemplate: 'hostTemplate',
            },
          ],
        },
      },
      agentSpec: {
        systemReminder: {
          thresholds: {
            budgetWarningRatio: 0.75,
          },
          extraRules: [
            {
              id: 'agent-rule',
              trigger: { kind: 'budget-warning', ratio: 0.75 },
              contentTemplate: 'agentTemplate',
            },
          ],
        },
      },
    });

    expect(merged.systemReminder?.thresholds).toEqual(expect.objectContaining({
      toolCallStreak: 5,
      budgetWarningRatio: 0.75,
    }));
    expect(merged.systemReminder?.extraRules).toEqual([
      {
        id: 'agent-rule',
        trigger: { kind: 'budget-warning', ratio: 0.75 },
        contentTemplate: 'agentTemplate',
      },
    ]);
  });
});
