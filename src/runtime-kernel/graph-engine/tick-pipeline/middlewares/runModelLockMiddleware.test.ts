import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInvocationRequest } from '../../../../ports/agent-invocation';
import type { TickPipelineContext, TickStage } from '../types';

const loggerWarnMock = vi.fn();

vi.mock('../../../../shared/logger', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    warn: loggerWarnMock,
  })),
}));

function createRequest(): AgentInvocationRequest {
  return {
    query: '继续执行',
    promptKey: 'default',
    model_id: 'cloud-primary-model',
    mode: 'agent',
    maxSteps: 8,
    enableTools: false,
    availableTools: [],
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
    modelId: 'cloud-primary-model',
    toolSchemas: [],
    llmOptions: {},
    llmMessages: [],
    mode: 'agent',
    conversationId: 'conv_model_lock',
    turnId: 'turn_model_lock',
  };
}

describe('runModelLockMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('仅在 execute_llm 后根据 fallback 结果写回 runLockedModelId', async () => {
    const { runModelLockMiddleware } = await import('./runModelLockMiddleware');
    const ctx = createContext();
    const stage: TickStage = {
      id: 'execute_llm',
      async run() {},
    };

    await runModelLockMiddleware(ctx, stage, async () => {
      ctx.cloudQuotaFallbackAppliedModelId = 'cloud-deepseek-reasoner';
    });

    expect(ctx.executorLocal?.runLockedModelId).toBe('cloud-deepseek-reasoner');
    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });
});
