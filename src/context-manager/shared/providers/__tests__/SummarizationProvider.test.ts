import { describe, expect, it } from 'vitest';
import type { AiMessage } from '../../../../contracts';
import type { MessageProcessingState, ProviderContext } from '../base';
import {
  ContextProviderError,
  SUMMARIZATION_FAILED_ERROR_CODE,
} from '../base';
import { SummarizationProvider } from '../SummarizationProvider';
import type { SummarizationConfig } from '../../summarization/config';

function makeMessage(index: number, type: 'user_input' | 'final_answer'): AiMessage {
  return {
    id: `${type}_${index}`,
    role: type === 'user_input' ? 'user' : 'assistant',
    type,
    content: `${type} content ${index}`.repeat(10),
    timestamp: index,
  };
}

function makeStates(): MessageProcessingState[] {
  return Array.from({ length: 8 }, (_, index) => {
    const message = makeMessage(
      index,
      index % 2 === 0 ? 'user_input' : 'final_answer',
    );
    return {
      message,
      originalIndex: index,
      action: 'keep_working_memory',
      tokens: 10,
    };
  });
}

function makeContext(
  generate: ProviderContext<SummarizationConfig>['generate'],
): ProviderContext<SummarizationConfig> {
  return {
    totalBudget: 1000,
    config: {
      SUMMARIZATION_TRIGGER_THRESHOLD: 0.01,
      SUMMARY_OLDEST_MESSAGES_PERCENTAGE: 0.75,
      TOKEN_ENCODING_NAME: 'cl100k_base',
    },
    debugMode: false,
    estimateTokens: message => Math.max(1, Math.ceil(message.content.length / 10)),
    generate,
  };
}

describe('SummarizationProvider', () => {
  it('calls the host generate hook with registered summarization agent id', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
      maxSummaryTokens: 200,
      language: 'zh',
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const requests: string[] = [];
    const context = makeContext(async (request) => {
      requests.push(request.promptKey);
      return { generatedText: '摘要结果' };
    });

    await provider.provide(makeStates(), 1000, context);

    expect(requests).toEqual(['history_compression']);
  });

  it('throws typed fatal error by default when summarization generation fails', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
      maxSummaryTokens: 200,
      language: 'zh',
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const context = makeContext(async () => {
      throw new Error('model failed');
    });

    await expect(provider.provide(makeStates(), 1000, context)).rejects.toMatchObject({
      name: 'ContextProviderError',
      code: SUMMARIZATION_FAILED_ERROR_CODE,
      fatal: true,
      providerName: 'SummarizationProvider',
    } satisfies Partial<ContextProviderError>);
  });

  it('continues with original context when configured and current tokens are within budget', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
      maxSummaryTokens: 200,
      language: 'zh',
      failureBehavior: 'continue-if-within-budget',
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const states = makeStates();
    const context = makeContext(async () => {
      throw new Error('model failed');
    });

    const result = await provider.provide(states, 1000, context);

    expect(result.states).toBe(states);
    expect(result.strategiesApplied).toContain('ai_history_summarization_failed_continue');
  });

  it('still fails fast when continue-if-within-budget would exceed budget', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
      maxSummaryTokens: 200,
      language: 'zh',
      failureBehavior: 'continue-if-within-budget',
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const context = makeContext(async () => {
      throw new Error('model failed');
    });

    await expect(provider.provide(makeStates(), 50, context)).rejects.toMatchObject({
      code: SUMMARIZATION_FAILED_ERROR_CODE,
      fatal: true,
    } satisfies Partial<ContextProviderError>);
  });
});
