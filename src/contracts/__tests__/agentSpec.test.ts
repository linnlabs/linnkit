import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentSpec,
  ToolBindingSpec,
} from '../agentSpec';
import {
  AgentSpecContextPolicy,
  defineContextPolicy,
} from '../contextPolicy';

describe('AgentSpec contract', () => {
  it('accepts a minimal valid spec', () => {
    const result = AgentSpec.safeParse({
      id: 'hello-agent',
      version: '0.1.0',
      capabilities: [],
      tools: [],
      contextPolicy: {
        profileId: 'agent',
      },
    });

    expect(result.success).toBe(true);
  });

  it('accepts a complete valid spec with all contextPolicy fields', () => {
    const result = AgentSpec.safeParse({
      id: 'research-agent',
      version: '1.2.3',
      role: 'researcher',
      description: 'Runs research tasks with tool-enabled context policy.',
      capabilities: ['llm:streaming', 'tool:web-search'],
      tools: [
        {
          toolId: 'web_search',
          bindingId: 'primary-search',
          argsSchema: {
            query: { type: 'string' },
          },
          config: {
            maxResults: 5,
          },
          metadata: {
            owner: 'linnya',
          },
        },
      ],
      contextPolicy: {
        profileId: 'agent',
        budget: {
          maxTokens: 120000,
          reservedForResponse: 2400,
          workingMemoryBudgetPercentage: 0.7,
        },
        toolHistory: {
          strategy: 'per-run',
          keepLatestToolPairs: 2,
          keepLatestRuns: 2,
          maxInteractionGroups: 12,
          overflowStrategy: 'fail-fast',
          maxPairTokens: 6000,
          maxOutputSummaryTokens: 1000,
        },
        toolOutput: {
          observationGovernance: {
            enabled: true,
            maxChars: 32000,
            maxLines: 1600,
          },
        },
        providerReplay: {
          provider: 'system_default',
          requiresReasoningDetailsForToolReplay: true,
          missingSidecarBehavior: 'provider_empty_replay_field',
        },
        summarization: {
          triggerThreshold: 0.7,
          budgetPercentage: 0.12,
          oldestMessagesPercentage: 0.75,
          agentId: 'history_compression',
          failureBehavior: 'continue-if-within-budget',
        },
        mustKeep: {
          alwaysKeepTypes: ['system_prompt', 'user_input', 'tool_output'],
          alwaysKeepFenceKinds: ['project-context'],
          truncationRules: [
            {
              fenceKind: 'memory-context',
              maxBudgetFraction: 0.2,
              strategyName: 'memory-truncate',
            },
          ],
        },
        workingMemory: {
          maxRecentToolInteractions: 3,
          minToolInteractionsToKeep: 2,
          toolPairingSearchRange: 12,
        },
        checkpoint: {
          keepPairsBefore: 4,
          triggerToolName: 'phase_checkpoint',
        },
        reasoningRetention: {
          keepLatestThoughts: 3,
        },
        tokenEstimation: {
          encoding: 'cl100k_base',
          avgCharsPerToken: 2,
          toolCallOverhead: 50,
        },
        systemReminder: {
          enabledRuleIds: ['last-steps-hint'],
          thresholds: {
            toolCallStreak: 10,
            taskstateReflectionPeriod: 30,
            budgetWarningRatio: 0.9,
            lastStepsHintThreshold: 2,
          },
          extraRules: [
            {
              id: 'memory-density-warning',
              trigger: {
                kind: 'tool-call-streak',
                threshold: 5,
                moduloStep: true,
              },
              contentTemplate: 'memoryDensityWarning',
              contentArgs: {
                resourceName: 'memory_recall',
              },
            },
          ],
        },
        contextTrace: {
          enabled: true,
          includeMessageIds: true,
          includeTokenBreakdown: true,
          maxTraceEvents: 200,
        },
      },
      modelHints: {
        preferredProviders: ['openai'],
        preferredModels: ['gpt-5.2'],
        fallbackChain: ['gpt-5.2', 'gpt-5.1'],
      },
      audit: {
        redactionLevel: 'standard',
        pii: true,
      },
      metadata: {
        team: 'framework',
      },
    });

    expect(result.success).toBe(true);
  });

  it('defineContextPolicy fills defaults without making minimal host policies invalid', () => {
    const explicitMinimalPolicy: AgentSpecContextPolicy = { profileId: 'agent' };
    const minimalResult = AgentSpecContextPolicy.safeParse(explicitMinimalPolicy);
    const policy = defineContextPolicy({
      toolHistory: {
        keepLatestRuns: 2,
      },
      contextTrace: {
        enabled: true,
      },
    });

    expect(minimalResult.success).toBe(true);
    expect(policy.profileId).toBe('agent');
    expect(policy.toolHistory?.strategy).toBe('per-run');
    expect(policy.toolHistory?.keepLatestRuns).toBe(2);
    expect(policy.toolOutput?.observationGovernance).toEqual({
      enabled: true,
      maxChars: 20_000,
      maxLines: 1_200,
    });
    expect(policy.providerReplay).toEqual({});
    expect(policy.mustKeep?.alwaysKeepTypes).toEqual(['system_prompt', 'user_input']);
    expect(policy.contextTrace?.enabled).toBe(true);
    expect(policy.contextTrace?.maxTraceEvents).toBe(200);
  });

  it('rejects invalid toolHistory strategy values', () => {
    const result = AgentSpec.safeParse({
      id: 'invalid-agent',
      version: '0.1.0',
      capabilities: [],
      tools: [],
      contextPolicy: {
        profileId: 'agent',
        toolHistory: {
          strategy: 'foo',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid overflowStrategy values', () => {
    const result = AgentSpec.safeParse({
      id: 'invalid-agent',
      version: '0.1.0',
      capabilities: [],
      tools: [],
      contextPolicy: {
        profileId: 'agent',
        toolHistory: {
          overflowStrategy: 'silent',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid providerReplay missing sidecar behavior values', () => {
    const result = AgentSpecContextPolicy.safeParse({
      profileId: 'agent',
      providerReplay: {
        missingSidecarBehavior: 'silent',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid toolOutput observation governance limits', () => {
    const result = AgentSpecContextPolicy.safeParse({
      profileId: 'agent',
      toolOutput: {
        observationGovernance: {
          maxChars: 0,
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects invalid mustKeep message types', () => {
    const result = AgentSpecContextPolicy.safeParse({
      profileId: 'agent',
      mustKeep: {
        alwaysKeepTypes: ['host_private_message'],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects simultaneous enabled and disabled system reminder rule lists', () => {
    const result = AgentSpecContextPolicy.safeParse({
      profileId: 'agent',
      systemReminder: {
        enabledRuleIds: ['a'],
        disabledRuleIds: ['b'],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects executable functions in system reminder content args', () => {
    const result = AgentSpecContextPolicy.safeParse({
      profileId: 'agent',
      systemReminder: {
        extraRules: [
          {
            id: 'unsafe-rule',
            trigger: {
              kind: 'tool-call-streak',
              threshold: 3,
            },
            contentTemplate: 'unsafeTemplate',
            contentArgs: {
              unsafe: () => true,
            },
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects non-string summarization agentId values', () => {
    const result = AgentSpecContextPolicy.safeParse({
      profileId: 'agent',
      summarization: {
        agentId: {
          prompt: 'do not inline prompt text',
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects runtime zod schemas in ToolBindingSpec.argsSchema', () => {
    const result = ToolBindingSpec.safeParse({
      toolId: 'unsafe-tool',
      argsSchema: z.any(),
    });

    expect(result.success).toBe(false);
  });
});
