import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAiEngine } from '../../../ports/ai-engine';
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
  let aiEngine: AgentAiEngine;
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
      billing_mode: 'byok',
      enable_client_retry: true,
      api_key: 'primary-key',
      model_name: 'primary-model',
      api_base: 'https://api.example.com/v1',
    });
    modelCatalog = {
      getModelById: getModelByIdMock,
      getModelsByCapability: vi.fn(() => []),
      getModelsByUIVisibility: vi.fn(() => []),
    };
    aiEngine = {
      chatCompletion: chatCompletionMock,
      chatCompletionStream: vi.fn(),
    };
  });

  it('Policy Model Switch 只通过 ModelResolver 选备用模型，不触发 quota fallback 回调', async () => {
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

    const onCloudQuotaFallbackApplied = vi.fn();
    const caller = new LlmCaller({ modelResolver, modelCatalog, aiEngine });

    const result = await caller.callWithRetries(
      'primary-model',
      messages,
      {},
      undefined,
      undefined,
      onCloudQuotaFallbackApplied,
    );

    expect(result).toBe('policy fallback success');
    expect(chatCompletionMock.mock.calls[0]?.[0]).toBe('primary-model');
    expect(chatCompletionMock.mock.calls[1]?.[0]).toBe('policy-fallback-model');
    expect(modelResolver.pickFallbackChatModel).toHaveBeenCalledTimes(1);
    expect(onCloudQuotaFallbackApplied).not.toHaveBeenCalled();
  });

  it('Cloud Quota Fallback 只走 run-scoped fallback model id，不借用 ModelResolver', async () => {
    const { LlmCaller } = await import('../caller');
    const modelResolver = {
      resolveModelId: vi.fn((modelId?: string) => modelId ?? 'default-model'),
      pickFallbackChatModel: vi.fn(() => 'policy-fallback-model'),
    };

    chatCompletionMock
      .mockRejectedValueOnce(new Error('今日使用次数已达上限（3次），明天再来吧'))
      .mockResolvedValueOnce('quota fallback success');
    decideOnErrorMock.mockReturnValue({
      action: 'none',
      reason: 'no policy switch',
    });
    getModelByIdMock.mockImplementation((id: string) => ({
      id,
      billing_mode: 'cloud',
      enable_client_retry: false,
      api_key: `${id}-key`,
      model_name: id,
      api_base: 'https://api.example.com/v1',
    }));

    const onCloudQuotaFallbackApplied = vi.fn();
    const caller = new LlmCaller({ modelResolver, modelCatalog, aiEngine });

    const result = await caller.callWithRetries(
      'cloud-primary-model',
      messages,
      { cloud_quota_fallback_model_id: 'cloud-deepseek-reasoner' },
      undefined,
      undefined,
      onCloudQuotaFallbackApplied,
    );

    expect(result).toBe('quota fallback success');
    expect(chatCompletionMock.mock.calls[0]?.[0]).toBe('cloud-primary-model');
    expect(chatCompletionMock.mock.calls[1]?.[0]).toBe('cloud-deepseek-reasoner');
    expect(modelResolver.pickFallbackChatModel).not.toHaveBeenCalled();
    expect(onCloudQuotaFallbackApplied).toHaveBeenCalledTimes(1);
    expect(onCloudQuotaFallbackApplied).toHaveBeenCalledWith('cloud-deepseek-reasoner');
  });
});
