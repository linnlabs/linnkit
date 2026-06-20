import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInvocationRequest } from '../../../../ports/agent-invocation';
import type { TokenizerPort } from '../../../../ports';
import { noopAudit } from '../../../audit/noopAudit';
import type { TelemetryPort } from '../../../telemetry/telemetryPort';
import type { TickPipelineContext, TickStage } from '../types';

const normalizeLlmUsageMock = vi.fn();
const recordLlmCallTelemetryMock = vi.fn();
const normalizedUsageFromCanonicalMock = vi.fn((canonicalUsage) => ({
  promptTokens: canonicalUsage.inputTokens,
  completionTokens: canonicalUsage.outputTokens,
  totalTokens: canonicalUsage.totalTokens ?? canonicalUsage.inputTokens + canonicalUsage.outputTokens,
  canonicalUsage,
}));

vi.mock('../../../../shared/llmTelemetryContext', () => ({
  normalizedUsageFromCanonical: normalizedUsageFromCanonicalMock,
  normalizeLlmUsage: normalizeLlmUsageMock,
  recordLlmCallTelemetry: recordLlmCallTelemetryMock,
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

function createTokenizerMock(): TokenizerPort & {
  estimateTextMock: ReturnType<typeof vi.fn>;
  estimateMessageMock: ReturnType<typeof vi.fn>;
} {
  const estimateTextMock = vi.fn(() => 5);
  const estimateMessageMock = vi.fn(() => 20);
  return {
    estimateTextMock,
    estimateMessageMock,
    estimateText: estimateTextMock,
    estimateMessage: estimateMessageMock,
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
      toolContext: {
        runId: 'run_telemetry',
        parentRunId: 'parent_run_telemetry',
      },
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
    audit: noopAudit,
    tokenizer: createTokenizerMock(),
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
    expect(ctx.tokenizer.estimateMessage).not.toHaveBeenCalled();
    expect(ctx.tokenizer.estimateText).not.toHaveBeenCalled();
  });

  it('provider usage 缺失时回退到 TokenizerPort 本地估算', async () => {
    const { llmTelemetryMiddleware } = await import('./llmTelemetryMiddleware');
    const ctx = createContext();
    const stage: TickStage = {
      id: 'execute_llm',
      async run() {},
    };

    normalizeLlmUsageMock.mockReturnValue(undefined);

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
        canonicalUsage: {
          inputTokens: 20,
          outputTokens: 5,
          totalTokens: 25,
          source: 'local-estimate',
          confidence: 'estimate',
        },
      },
      canonicalUsage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25,
        source: 'local-estimate',
        confidence: 'estimate',
      },
    });
    expect(ctx.tokenizer.estimateMessage).toHaveBeenCalledWith({ role: 'user', content: 'hello' }, 'mock-model');
    expect(ctx.tokenizer.estimateText).toHaveBeenCalledWith('partial answer', 'mock-model');
  });

  it('usage.tokens 这种只有总量的旧 mock 不会被伪造成 provider actual', async () => {
    const { llmTelemetryMiddleware } = await import('./llmTelemetryMiddleware');
    const ctx = createContext();
    const stage: TickStage = {
      id: 'execute_llm',
      async run() {},
    };

    normalizeLlmUsageMock.mockReturnValue(undefined);

    await llmTelemetryMiddleware(ctx, stage, async () => {
      ctx.llmResp = {
        content: 'answer',
        usage: { tokens: 100 },
      };
    });

    expect(normalizeLlmUsageMock).toHaveBeenCalledWith({ tokens: 100 });
    expect(recordLlmCallTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({
          promptTokens: 20,
          completionTokens: 5,
          canonicalUsage: expect.objectContaining({
            source: 'local-estimate',
            confidence: 'estimate',
          }),
        }),
      }),
    );
  });

  it('优先使用 host 回传的 canonicalUsage，不从 raw usage 猜字段', async () => {
    const { llmTelemetryMiddleware } = await import('./llmTelemetryMiddleware');
    const ctx = createContext();
    const stage: TickStage = {
      id: 'execute_llm',
      async run() {},
    };
    const canonicalUsage = {
      inputTokens: 8,
      outputTokens: 3,
      cacheReadTokens: 2,
      totalTokens: 13,
      source: 'host-supplied' as const,
      confidence: 'actual' as const,
    };

    await llmTelemetryMiddleware(ctx, stage, async () => {
      ctx.llmResp = {
        content: 'answer',
        usage: { prompt_tokens: 999, completion_tokens: 999, total_tokens: 1998 },
        canonicalUsage,
      };
    });

    expect(normalizeLlmUsageMock).not.toHaveBeenCalled();
    expect(recordLlmCallTelemetryMock).toHaveBeenCalledWith({
      modelId: 'mock-model',
      stream: true,
      startedAt: 100,
      durationMs: 35,
      usage: {
        promptTokens: 8,
        completionTokens: 3,
        totalTokens: 13,
        canonicalUsage,
      },
      canonicalUsage,
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
          runId: 'run_telemetry',
          parentRunId: 'parent_run_telemetry',
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
      const tokenizer = createTokenizerMock();
      tokenizer.estimateMessageMock.mockReturnValue(0);
      tokenizer.estimateTextMock.mockReturnValue(0);
      ctx.tokenizer = tokenizer;

      await llmTelemetryMiddleware(ctx, stage, async () => {
        ctx.llmResp = { content: '' };
      });

      expect(telemetry.emitMock).toHaveBeenCalledTimes(1);
      const emittedEvent = telemetry.emitMock.mock.calls[0]![0];
      expect(emittedEvent.scope).toEqual({
        conversationId: undefined,
        runId: 'run_telemetry',
        parentRunId: 'parent_run_telemetry',
        turnId: 'turn_telemetry',
      });
    });
  });
});
