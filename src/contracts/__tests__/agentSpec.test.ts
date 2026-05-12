import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentSpec,
  ToolBindingSpec,
} from '../agentSpec';

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
        summarization: {
          triggerThreshold: 0.7,
          budgetPercentage: 0.12,
          oldestMessagesPercentage: 0.75,
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

  it('rejects runtime zod schemas in ToolBindingSpec.argsSchema', () => {
    const result = ToolBindingSpec.safeParse({
      toolId: 'unsafe-tool',
      argsSchema: z.any(),
    });

    expect(result.success).toBe(false);
  });
});
