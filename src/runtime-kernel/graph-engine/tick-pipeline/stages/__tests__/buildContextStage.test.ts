import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  GraphExecutorContextBuilder,
  GraphExecutorContextBuildOutput,
} from '../../../executorContextBuilder';
import type { TelemetryPort } from '../../../../telemetry';
import { createBuildContextStage } from '../buildContextStage';
import { createTestTickPipelineContext } from '../../__tests__/createTestTickPipelineContext';
import { runTickPipeline } from '../../runTickPipeline';
import { RunIdSchema } from '../../../../../contracts';

function createTelemetrySpy(): TelemetryPort & { emitMock: ReturnType<typeof vi.fn> } {
  const emitMock = vi.fn();
  return {
    emit: emitMock,
    emitMock,
  };
}

describe('buildContextStage telemetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('应把 contextTrace 收口为可序列化 JSON record', async () => {
    const contextBuilder = {
      build: vi.fn(
        async (): Promise<GraphExecutorContextBuildOutput> => ({
          llmMessages: [{ role: 'user', content: 'hello' }],
          summaryEvents: [],
          imageInputAdmissionEvidence: {
            inputBudget: 100,
            nonImageEstimatedTokens: 10,
            initialProfileId: 'test-profile',
            attachments: [],
          },
          contextTrace: {
            kind: 'test_trace',
            messageCount: 1,
            nested: {
              kept: true,
              dropped: undefined,
            },
            skipped: () => undefined,
          },
        })
      ),
    } satisfies GraphExecutorContextBuilder;
    const ctx = createTestTickPipelineContext();

    await runTickPipeline(ctx, [createBuildContextStage({ contextBuilder })]);

    expect(ctx.contextTrace).toEqual({
      kind: 'test_trace',
      messageCount: 1,
      nested: {
        kept: true,
      },
    });
    expect(ctx.imageInputAdmissionEvidence).toEqual({
      inputBudget: 100,
      nonImageEstimatedTokens: 10,
      initialProfileId: 'test-profile',
      attachments: [],
    });
  });

  it('context builder 暴露 tokenEstimate 时发出 context_build telemetry', async () => {
    const telemetry = createTelemetrySpy();
    const contextBuilder: GraphExecutorContextBuilder = {
      build: vi.fn(
        async (): Promise<GraphExecutorContextBuildOutput> => ({
          llmMessages: [{ role: 'user', content: 'hello' }],
          summaryEvents: [],
          tokenEstimate: {
            route: {
              providerId: 'openrouter',
              baseURL: 'https://openrouter.ai/api/v1',
              modelId: 'glm-via-openrouter',
              providerModelId: 'z-ai/glm-4.5',
            },
            localEstimateTokens: 20,
            calibratedEstimateTokens: 40,
            finalTokens: 40,
            source: 'local-estimate',
            confidence: 'estimate',
          },
          tokenComponents: [
            {
              componentId: '0:user-1',
              kind: 'user',
              tokens: 40,
              source: 'local-estimate',
              confidence: 'estimate',
              messageId: 'user-1',
              kept: true,
            },
            {
              componentId: '1:old-answer',
              kind: 'assistant',
              tokens: 12,
              source: 'local-estimate',
              confidence: 'estimate',
              messageId: 'old-answer',
              kept: false,
            },
          ],
        })
      ),
    };
    const ctx = createTestTickPipelineContext({
      context: {
        telemetry,
        modelId: 'glm-via-openrouter',
        conversationId: 'conv_context_build',
        turnId: 'turn_context_build',
        input: {
          request: {
            query: '继续执行',
            promptKey: 'default',
            model_id: 'glm-via-openrouter',
          },
          history: [],
          toolContext: {
            runId: RunIdSchema.parse('run_context_build'),
            parentRunId: RunIdSchema.parse('parent_context_build'),
          },
        },
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime(1_234);
    await runTickPipeline(ctx, [createBuildContextStage({ contextBuilder })]);

    expect(telemetry.emitMock).toHaveBeenCalledWith({
      kind: 'context_build',
      modelId: 'glm-via-openrouter',
      tokenEstimate: {
        route: {
          providerId: 'openrouter',
          baseURL: 'https://openrouter.ai/api/v1',
          modelId: 'glm-via-openrouter',
          providerModelId: 'z-ai/glm-4.5',
        },
        localEstimateTokens: 20,
        calibratedEstimateTokens: 40,
        finalTokens: 40,
        source: 'local-estimate',
        confidence: 'estimate',
      },
      tokenComponents: [
        {
          componentId: '0:user-1',
          kind: 'user',
          tokens: 40,
          source: 'local-estimate',
          confidence: 'estimate',
          messageId: 'user-1',
          kept: true,
        },
        {
          componentId: '1:old-answer',
          kind: 'assistant',
          tokens: 12,
          source: 'local-estimate',
          confidence: 'estimate',
          messageId: 'old-answer',
          kept: false,
        },
      ],
      tokenLedgerEntry: {
        id: expect.stringMatching(/^context-ledger-[a-f0-9]{32}$/),
        kind: 'context-component',
        conversationId: 'conv_context_build',
        runId: 'run_context_build',
        parentRunId: 'parent_context_build',
        turnId: 'turn_context_build',
        createdAt: 1_234,
        route: {
          providerId: 'openrouter',
          baseURL: 'https://openrouter.ai/api/v1',
          modelId: 'glm-via-openrouter',
          providerModelId: 'z-ai/glm-4.5',
        },
        components: [
          {
            componentId: '0:user-1',
            kind: 'user',
            tokens: 40,
            source: 'local-estimate',
            confidence: 'estimate',
            messageId: 'user-1',
            kept: true,
          },
        ],
        totalTokens: 40,
      },
      scope: {
        conversationId: 'conv_context_build',
        runId: 'run_context_build',
        parentRunId: 'parent_context_build',
        turnId: 'turn_context_build',
      },
    });
  });

  it('context builder 暴露内部 LLM usage 时发出带阶段标记的 llm_call telemetry', async () => {
    const telemetry = createTelemetrySpy();
    const canonicalUsage = {
      inputTokens: 80,
      outputTokens: 12,
      totalTokens: 92,
      source: 'provider-response-usage' as const,
      confidence: 'actual' as const,
    };
    const contextBuilder: GraphExecutorContextBuilder = {
      build: vi.fn(
        async (): Promise<GraphExecutorContextBuildOutput> => ({
          llmMessages: [{ role: 'user', content: 'hello' }],
          summaryEvents: [],
          internalLlmCalls: [
            {
              purpose: 'summarization',
              modelId: 'summary-model',
              canonicalUsage,
            },
          ],
        })
      ),
    };
    const ctx = createTestTickPipelineContext({
      context: {
        telemetry,
        modelId: 'main-model',
        conversationId: 'conv_internal_llm',
        turnId: 'turn_internal_llm',
        input: {
          request: {
            query: '继续执行',
            promptKey: 'default',
            model_id: 'main-model',
          },
          history: [],
          toolContext: {
            runId: RunIdSchema.parse('run_internal_llm'),
            parentRunId: RunIdSchema.parse('parent_internal_llm'),
          },
        },
      },
    });

    await runTickPipeline(ctx, [createBuildContextStage({ contextBuilder })]);

    expect(telemetry.emitMock).toHaveBeenCalledWith({
      kind: 'llm_call',
      modelId: 'summary-model',
      stream: false,
      durationMs: 0,
      usage: {
        promptTokens: 80,
        completionTokens: 12,
        totalTokens: 92,
        canonicalUsage,
      },
      canonicalUsage,
      phase: 'context-internal',
      purpose: 'summarization',
      scope: {
        conversationId: 'conv_internal_llm',
        runId: 'run_internal_llm',
        parentRunId: 'parent_internal_llm',
        turnId: 'turn_internal_llm',
      },
    });
  });
});
