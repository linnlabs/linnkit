import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GraphExecutorContextBuilder } from '../../../executorContextBuilder';
import type { TelemetryPort } from '../../../../telemetry';
import { createBuildContextStage } from '../buildContextStage';
import { createTestTickPipelineContext } from '../../__tests__/createTestTickPipelineContext';

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

  it('context builder 暴露 tokenEstimate 时发出 context_build telemetry', async () => {
    const telemetry = createTelemetrySpy();
    const contextBuilder: GraphExecutorContextBuilder = {
      build: vi.fn(async () => ({
        mode: 'agent',
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
      })),
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
            mode: 'agent',
          },
          history: [],
          toolContext: {
            runId: 'run_context_build',
            parentRunId: 'parent_context_build',
          },
        },
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime(1_234);
    await createBuildContextStage({ contextBuilder }).run(ctx);

    expect(telemetry.emitMock).toHaveBeenCalledWith({
      kind: 'context_build',
      modelId: 'glm-via-openrouter',
      mode: 'agent',
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
        id: 'context_run_context_build_turn_context_build_1234',
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
});
