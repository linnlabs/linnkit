import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalInferencePort } from '../../../ports';
import type { ModelCatalogLike } from '../modelCatalog';
import type { AiMessage } from '../../../contracts';

const chatCompletionMock = vi.fn();
const getModelByIdMock = vi.fn();
const decideOnErrorMock = vi.fn();

vi.mock('../policies/defaultPolicyEngine', () => ({
  defaultPolicyEngine: {
    decideOnError: decideOnErrorMock,
  },
}));

describe('LlmCaller fallback boundary', () => {
  let inferencePort: CanonicalInferencePort;
  let modelCatalog: ModelCatalogLike;
  const messages: AiMessage[] = [
    {
      role: 'user',
      type: 'user_input',
      content: '继续执行',
      id: 'msg_fallback_boundary',
      timestamp: Date.now(),
    },
  ];

  beforeEach(() => {
    vi.resetModules();
    chatCompletionMock.mockReset();
    getModelByIdMock.mockReset();
    decideOnErrorMock.mockReset();
    getModelByIdMock.mockReturnValue({
      id: 'primary-model',
      enable_client_retry: true,
      api_key: 'primary-key',
      model_name: 'primary-model',
      capabilities: ['chat'],
    });
    modelCatalog = {
      getModelById: getModelByIdMock,
      getModelsByCapability: vi.fn(() => []),
      getModelsByUIVisibility: vi.fn(() => []),
    };
    inferencePort = {
      async *stream(request) {
        yield {
          type: 'start',
          model_id: request.model_id,
          attempt_id: request.invocation.attempt_id,
        };
        const content = await chatCompletionMock(request.model_id, request.messages);
        if (typeof content === 'string' && content) {
          yield { type: 'answer_delta', text: content };
        }
        yield { type: 'finish', reason: 'stop' };
      },
    };
  });

  it('Policy Model Switch 只通过 ModelResolver 选备用模型', async () => {
    const { LlmCaller } = await import('../caller');
    const modelResolver = {
      resolveModelId: vi.fn((modelId?: string) => modelId ?? 'default-model'),
      pickFallbackChatModel: vi.fn(() => 'policy-fallback-model'),
    };

    chatCompletionMock
      .mockRejectedValueOnce(new Error('policy switch wanted'))
      .mockResolvedValueOnce('policy fallback success');
    decideOnErrorMock.mockReturnValue({
      action: 'switch_model',
      reason: 'policy boundary',
    });

    const caller = new LlmCaller({ modelResolver, modelCatalog, inferencePort });

    const result = await caller.callWithRetries(
      'primary-model',
      messages,
      {},
      undefined,
      undefined,
    );

    expect(result).toEqual({ content: 'policy fallback success' });
    expect(chatCompletionMock.mock.calls[0]?.[0]).toBe('primary-model');
    expect(chatCompletionMock.mock.calls[1]?.[0]).toBe('policy-fallback-model');
    expect(modelResolver.pickFallbackChatModel).toHaveBeenCalledTimes(1);
  });

  it('固定模型调用不应被 Policy Model Switch 自动切到备用模型', async () => {
    const { LlmCaller } = await import('../caller');
    const modelResolver = {
      resolveModelId: vi.fn((modelId?: string) => modelId ?? 'default-model'),
      pickFallbackChatModel: vi.fn(() => 'policy-fallback-model'),
    };

    chatCompletionMock.mockRejectedValueOnce(new Error('policy switch wanted'));
    decideOnErrorMock.mockReturnValue({
      action: 'switch_model',
      reason: 'policy boundary',
    });

    const caller = new LlmCaller({ modelResolver, modelCatalog, inferencePort });

    await expect(
      caller.callWithRetries(
        'primary-model',
        messages,
        { allow_model_fallback: false },
      ),
    ).rejects.toThrow('policy switch wanted');

    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    expect(chatCompletionMock.mock.calls[0]?.[0]).toBe('primary-model');
    expect(modelResolver.pickFallbackChatModel).not.toHaveBeenCalled();
  });

  it('Policy Model Switch 不能绕开 maxTotalAttempts 继续多级切模型', async () => {
    const { LlmCaller } = await import('../caller');
    const modelResolver = {
      resolveModelId: vi.fn((modelId?: string) => modelId ?? 'default-model'),
      pickFallbackChatModel: vi.fn()
        .mockReturnValueOnce('policy-fallback-a')
        .mockReturnValueOnce('policy-fallback-b'),
    };

    chatCompletionMock
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockRejectedValueOnce(new Error('fallback failed'));
    decideOnErrorMock.mockReturnValue({
      action: 'switch_model',
      reason: 'policy boundary',
    });

    const caller = new LlmCaller({
      modelResolver,
      modelCatalog,
      inferencePort,
      maxRetries: 0,
      maxTotalAttempts: 2,
    });

    await expect(caller.callWithRetries('primary-model', messages)).rejects.toThrow('fallback failed');

    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
    expect(chatCompletionMock.mock.calls[0]?.[0]).toBe('primary-model');
    expect(chatCompletionMock.mock.calls[1]?.[0]).toBe('policy-fallback-a');
    expect(modelResolver.pickFallbackChatModel).toHaveBeenCalledTimes(1);
  });

  it('Policy Model Switch 跳过容量不足候选，并记录明确拒绝原因', async () => {
    const { LlmCaller } = await import('../caller');
    const modelResolver = {
      resolveModelId: vi.fn((modelId?: string) => modelId ?? 'default-model'),
      pickFallbackChatModel: vi.fn()
        .mockReturnValueOnce('small-window-model')
        .mockReturnValueOnce('large-window-model'),
    };
    chatCompletionMock
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockResolvedValueOnce('large fallback success');
    decideOnErrorMock.mockReturnValue({
      action: 'switch_model',
      reason: 'policy boundary',
    });
    const onModelFallbackRejected = vi.fn();
    const caller = new LlmCaller({ modelResolver, modelCatalog, inferencePort });

    await expect(caller.callWithRetries(
      'primary-model',
      messages,
      {},
      undefined,
      undefined,
      { onModelFallbackRejected },
      {
        evaluateFallbackPromptCapacity: candidateModelId => candidateModelId === 'small-window-model'
          ? { admitted: false, reason: 'fallback_context_window_exceeded' }
          : { admitted: true },
      },
    )).resolves.toEqual({ content: 'large fallback success' });

    expect(chatCompletionMock.mock.calls.map(call => call[0])).toEqual([
      'primary-model',
      'large-window-model',
    ]);
    expect(modelResolver.pickFallbackChatModel).toHaveBeenCalledTimes(2);
    expect(onModelFallbackRejected).toHaveBeenCalledWith(expect.objectContaining({
      candidateModelId: 'small-window-model',
      reason: 'fallback_context_window_exceeded',
    }));
  });
});
