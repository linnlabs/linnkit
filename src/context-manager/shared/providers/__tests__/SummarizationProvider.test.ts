import { describe, expect, it } from 'vitest';
import type { AiMessage } from '../../../../contracts';
import type { MessageProcessingState, ProviderContext } from '../base';
import {
  ContextProviderError,
  SUMMARIZATION_FAILED_ERROR_CODE,
} from '../base';
import { SummarizationProvider } from '../SummarizationProvider';
import type { SummarizationConfig } from '../../summarization/config';
import type { SummarizationProviderContext } from '../../summarization/config';

function makeMessage(index: number, type: 'user_input' | 'final_answer'): AiMessage {
  if (type === 'user_input') {
    return {
      id: `${type}_${index}`,
      role: 'user',
      type,
      content: `${type} content ${index}`.repeat(10),
      timestamp: index,
    };
  }

  return {
    id: `${type}_${index}`,
    role: 'assistant',
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
  generateSummary: ProviderContext<SummarizationConfig>['generateSummary'],
  options: {
    config?: Partial<SummarizationConfig>;
    estimateTokens?: ProviderContext<SummarizationConfig>['estimateTokens'];
    summarizationProtectedRanges?: readonly { startIndex: number; endIndex: number }[];
  } = {},
): SummarizationProviderContext {
  return {
    totalBudget: 1000,
    config: {
      SUMMARIZATION_TRIGGER_THRESHOLD: 0.01,
      SUMMARY_OLDEST_MESSAGES_PERCENTAGE: 0.75,
      TOKEN_ENCODING_NAME: 'cl100k_base',
      ...options.config,
    },
    debugMode: false,
    estimateTokens: options.estimateTokens ?? (message => Math.max(1, Math.ceil(message.content.length / 10))),
    generateSummary,
    summarizationProtectedRanges: options.summarizationProtectedRanges,
  };
}

describe('SummarizationProvider', () => {
  it('calls the host summary port with the registered summarization agent id', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const requests: Array<{ agentId: string; content: string; modelId: string }> = [];
    const context = makeContext(async (request) => {
      requests.push(request);
      return { summary: '摘要结果' };
    });

    await provider.provide(makeStates(), 1000, context);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      agentId: 'history_compression',
      modelId: 'summary-model',
    });
    expect(requests[0]?.content).toContain('user: user_input content 0');
  });

  it('uses state token estimates from the active context estimator when deciding to summarize', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const requests: string[] = [];
    const states = makeStates().map((state) => ({
      ...state,
      message: {
        ...state.message,
        content: 'x',
      },
      tokens: 100,
    }));
    const context = makeContext(async (request) => {
      requests.push(request.agentId);
      return { summary: '摘要结果' };
    }, {
      config: {
        SUMMARIZATION_TRIGGER_THRESHOLD: 0.5,
      },
      estimateTokens: () => 100,
    });

    await provider.provide(states, 1000, context);

    expect(requests).toEqual(['history_compression']);
  });

  it('passes summary LLM canonical usage through provider sidecar data', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const canonicalUsage = {
      inputTokens: 123,
      outputTokens: 17,
      totalTokens: 140,
      source: 'provider-response-usage' as const,
      confidence: 'actual' as const,
    };
    const context = makeContext(async () => ({
      summary: '摘要结果',
      canonicalUsage,
    }));

    const result = await provider.provide(makeStates(), 1000, context);

    expect(result.internalLlmCalls).toEqual([
      {
        purpose: 'summarization',
        modelId: 'summary-model',
        canonicalUsage,
      },
    ]);
    expect(result.events).toHaveLength(1);
  });

  it('含图会话轮次作为区段屏障，prompt 与 replacedMessageIds 都不能跨过它', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
      maxRetries: 1,
      retryDelayMs: 0,
    });
    const states = Array.from({ length: 14 }, (_, index) => ({
      message: makeMessage(index, index % 2 === 0 ? 'user_input' : 'final_answer'),
      originalIndex: index,
      action: 'keep_working_memory' as const,
      tokens: 10,
    }));
    const imageMessage: AiMessage = {
      id: 'user_input_6',
      role: 'user',
      type: 'user_input',
      content: 'IMAGE_TURN_MUST_NOT_BE_SUMMARIZED',
      timestamp: 6,
      attachments: [{
        id: 'attachment-1',
        kind: 'image',
        resourceId: 'asset-1',
        mediaType: 'image/png',
        byteLength: 128,
        width: 16,
        height: 8,
        sha256: 'a'.repeat(64),
      }],
    };
    states[6] = { ...states[6], message: imageMessage };
    let summaryPrompt = '';
    const context = makeContext(async request => {
      summaryPrompt = request.content;
      return { summary: '摘要结果' };
    }, {
      summarizationProtectedRanges: [{ startIndex: 6, endIndex: 7 }],
    });

    const result = await provider.provide(states, 1000, context);
    const summaryEvent = result.events?.find(event => event.type === 'history_summary');

    expect(summaryPrompt).not.toContain('IMAGE_TURN_MUST_NOT_BE_SUMMARIZED');
    expect(summaryEvent).toMatchObject({
      replaced_message_ids: ['user_input_0', 'final_answer_1', 'user_input_2', 'final_answer_3'],
    });
    const retainedImageMessage = result.states.find(state => state.message.id === 'user_input_6')?.message;
    expect(retainedImageMessage && 'attachments' in retainedImageMessage
      ? retainedImageMessage.attachments
      : undefined).toHaveLength(1);
  });

  it('throws typed fatal error by default when summarization generation fails', async () => {
    const provider = new SummarizationProvider({
      agentId: 'history_compression',
      modelId: 'summary-model',
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
