import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInvocationRequest } from '../../../../ports/agent-invocation';
import type { TickPipelineContext } from '../types';

const getModelByIdMock = vi.fn();

function createRequest(): AgentInvocationRequest {
  return {
    query: '继续执行',
    promptKey: 'default',
    model_id: 'requested-model',
    mode: 'agent',
    maxSteps: 8,
    enableTools: true,
    availableTools: ['tool_a'],
  };
}

function createContext(): TickPipelineContext {
  const request = createRequest();
  return {
    input: {
      request,
      history: [],
      stream: false,
    },
    newEvents: [],
    request,
    history: [],
    forceFinalAnswer: false,
    executorLocal: {
      stepCount: 1,
    },
    modelId: '',
    toolSchemas: [],
    llmOptions: {},
    llmMessages: [],
    mode: 'agent',
    conversationId: 'conv_prepare_call',
    turnId: 'turn_prepare_call',
  };
}

describe('createPrepareCallStage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModelByIdMock.mockReturnValue(undefined);
  });

  it('通过 ModelResolver 解析模型，不再依赖 LlmCaller', async () => {
    const { createPrepareCallStage } = await import('./prepareCallStage');
    const ctx = createContext();
    const modelResolver = {
      resolveModelId: vi.fn(() => 'resolved-model'),
    };
    const toolCatalog = {
      getToolSchemas: vi.fn(() => []),
    };

    const stage = createPrepareCallStage({
      modelResolver,
      modelCatalog: { getModelById: getModelByIdMock },
      toolCatalog,
    });

    await stage.run(ctx);

    expect(modelResolver.resolveModelId).toHaveBeenCalledWith('requested-model');
    expect(ctx.modelId).toBe('resolved-model');
  });

  it('run 内续跑（stepCount≠2）时，cloud 模型应附加 quota fallback 选项', async () => {
    const { createPrepareCallStage } = await import('./prepareCallStage');
    const ctx = createContext();
    // stepCount=3 模拟 tool 执行后续跑的 LLM 调用
    ctx.executorLocal = {
      stepCount: 3,
      runLockedModelId: 'locked-model',
    };
    const modelResolver = {
      resolveModelId: vi.fn(() => 'locked-model'),
    };
    const toolCatalog = {
      getToolSchemas: vi.fn(() => []),
    };

    getModelByIdMock.mockReturnValue({
      id: 'locked-model',
      billing_mode: 'cloud',
    });

    const stage = createPrepareCallStage({
      modelResolver,
      modelCatalog: { getModelById: getModelByIdMock },
      toolCatalog,
      cloudQuotaFallbackModelId: 'cloud-deepseek-reasoner',
    });

    await stage.run(ctx);

    expect(modelResolver.resolveModelId).toHaveBeenCalledWith('locked-model');
    expect(ctx.llmOptions.cloud_quota_fallback_model_id).toBe('cloud-deepseek-reasoner');
  });

  it('用户发起的首次 LLM 调用（stepCount===2）不应设置 quota fallback', async () => {
    const { createPrepareCallStage } = await import('./prepareCallStage');
    const ctx = createContext();
    // stepCount=2 表示 user(step 1)→llm(step 2)，即用户发起的首次 LLM 调用
    ctx.executorLocal = {
      stepCount: 2,
      runLockedModelId: 'locked-model',
    };
    const modelResolver = {
      resolveModelId: vi.fn(() => 'locked-model'),
    };
    const toolCatalog = {
      getToolSchemas: vi.fn(() => []),
    };

    getModelByIdMock.mockReturnValue({
      id: 'locked-model',
      billing_mode: 'cloud',
    });

    const stage = createPrepareCallStage({
      modelResolver,
      modelCatalog: { getModelById: getModelByIdMock },
      toolCatalog,
      cloudQuotaFallbackModelId: 'cloud-deepseek-reasoner',
    });

    await stage.run(ctx);

    expect(ctx.llmOptions.cloud_quota_fallback_model_id).toBeUndefined();
  });
});
