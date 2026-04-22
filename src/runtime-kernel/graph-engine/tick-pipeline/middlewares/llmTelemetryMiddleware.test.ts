import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInvocationRequest } from '../../../../ports/agent-invocation';
import type { TelemetryPort } from '../../../telemetry/telemetryPort';
import type { TickPipelineContext, TickStage } from '../types';

const normalizeLlmUsageMock = vi.fn();
const recordLlmCallTelemetryMock = vi.fn();
const estimateMessagesTokensPreciseMock = vi.fn();
const estimateTokensPreciseMock = vi.fn();

vi.mock('../../../../shared/llmTelemetryContext', () => ({
  normalizeLlmUsage: normalizeLlmUsageMock,
  recordLlmCallTelemetry: recordLlmCallTelemetryMock,
}));

vi.mock('../../../../shared/TokenCalculator', () => ({
  TokenCalculator: {
    estimateMessagesTokensPrecise: estimateMessagesTokensPreciseMock,
    estimateTokensPrecise: estimateTokensPreciseMock,
  },
}));

function createRequest(): AgentInvocationRequest {
  return {
    query: '继续执行',
    promptKey: 'default',
    model_id: 'mock-model',
    mode: 'agent',
    maxSteps: 8,
    enableTools: false,
    availableTools: [],
  };
}

function createTelemetrySpy(): TelemetryPort & {
  emitMock: ReturnType<typeof vi.fn>;
} {
  const emitMock = vi.fn();
  return {
    emit: emitMock,
    emitMock,
  };
}

function createContext(
  telemetry: TelemetryPort = { emit: vi.fn() },
): TickPipelineContext {
  const request = createRequest();
  return {
    input: {
      request,
      history: [],
      stream: true,
    },
    newEvents: [],
    request,
    history: [],
    forceFinalAnswer: false,
    modelId: 'mock-model',
    toolSchemas: [],
    llmOptions: {},
    llmMessages: [{ role: 'user', content: 'hello' }],
    mode: 'agent',
    conversationId: 'conv_telemetry',
    turnId: 'turn_telemetry',
    llmCallStartedAt: 100,
    llmCallDurationMs: 35,
    telemetry,
  };
}

describe('llmTelemetryMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('优先使用 provider usage 归一化结果记录 telemetry', async () => {
    const { llmTelemetryMiddleware } = await import('./llmTelemetryMiddleware');
    const ctx = createContext();
    const stage: TickStage = {
      id: 'execute_llm',
      async run() {},
    };

    normalizeLlmUsageMock.mockReturnValue({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });

    await llmTelemetryMiddleware(ctx, stage, async () => {
      ctx.llmResp = {
        content: 'final answer',
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      };
    });

    expect(normalizeLlmUsageMock).toHaveBeenCalledWith({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
    expect(recordLlmCallTelemetryMock).toHaveBeenCalledWith({
      modelId: 'mock-model',
      stream: true,
      startedAt: 100,
      durationMs: 35,
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });
    expect(estimateMessagesTokensPreciseMock).not.toHaveBeenCalled();
    expect(estimateTokensPreciseMock).not.toHaveBeenCalled();
  });

  it('provider usage 缺失时回退到本地 token 估算', async () => {
    const { llmTelemetryMiddleware } = await import('./llmTelemetryMiddleware');
    const ctx = createContext();
    const stage: TickStage = {
      id: 'execute_llm',
      async run() {},
    };

    normalizeLlmUsageMock.mockReturnValue(undefined);
    estimateMessagesTokensPreciseMock.mockReturnValue(20);
    estimateTokensPreciseMock.mockReturnValue(5);

    await llmTelemetryMiddleware(ctx, stage, async () => {
      ctx.llmResp = {
        content: 'partial answer',
      };
    });

    expect(recordLlmCallTelemetryMock).toHaveBeenCalledWith({
      modelId: 'mock-model',
      stream: true,
      startedAt: 100,
      durationMs: 35,
      usage: {
        promptTokens: 20,
        completionTokens: 5,
        totalTokens: 25,
      },
    });
  });

  describe('B2-engine Batch 1: TelemetryPort emit', () => {
    it('emits llm_call event to ctx.telemetry with usage + scope', async () => {
      const { llmTelemetryMiddleware } = await import('./llmTelemetryMiddleware');
      const telemetry = createTelemetrySpy();
      const ctx = createContext(telemetry);
      const stage: TickStage = {
        id: 'execute_llm',
        async run() {},
      };

      normalizeLlmUsageMock.mockReturnValue({
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      });

      await llmTelemetryMiddleware(ctx, stage, async () => {
        ctx.llmResp = {
          content: 'final answer',
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        };
      });

      expect(telemetry.emitMock).toHaveBeenCalledTimes(1);
      expect(telemetry.emitMock).toHaveBeenCalledWith({
        kind: 'llm_call',
        modelId: 'mock-model',
        stream: true,
        durationMs: 35,
        usage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
        scope: {
          conversationId: 'conv_telemetry',
          turnId: 'turn_telemetry',
        },
      });
    });

    it('does NOT emit when stage.id !== execute_llm', async () => {
      const { llmTelemetryMiddleware } = await import('./llmTelemetryMiddleware');
      const telemetry = createTelemetrySpy();
      const ctx = createContext(telemetry);
      const stage: TickStage = {
        id: 'build_context',
        async run() {},
      };

      await llmTelemetryMiddleware(ctx, stage, async () => {});

      expect(telemetry.emitMock).not.toHaveBeenCalled();
      expect(recordLlmCallTelemetryMock).not.toHaveBeenCalled();
    });

    it('omits conversationId from scope when ctx.conversationId is empty string', async () => {
      const { llmTelemetryMiddleware } = await import('./llmTelemetryMiddleware');
      const telemetry = createTelemetrySpy();
      const ctx = createContext(telemetry);
      ctx.conversationId = '';
      const stage: TickStage = {
        id: 'execute_llm',
        async run() {},
      };

      normalizeLlmUsageMock.mockReturnValue(undefined);
      estimateMessagesTokensPreciseMock.mockReturnValue(0);
      estimateTokensPreciseMock.mockReturnValue(0);

      await llmTelemetryMiddleware(ctx, stage, async () => {
        ctx.llmResp = { content: '' };
      });

      expect(telemetry.emitMock).toHaveBeenCalledTimes(1);
      const emittedEvent = telemetry.emitMock.mock.calls[0]![0];
      expect(emittedEvent.scope).toEqual({
        conversationId: undefined,
        turnId: 'turn_telemetry',
      });
    });
  });
});
