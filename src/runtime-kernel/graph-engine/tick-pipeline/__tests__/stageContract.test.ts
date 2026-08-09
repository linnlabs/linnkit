import { describe, expect, it, vi } from 'vitest';

import type { AgentInvocationRequest, LlmRequestMessage } from '../../../../ports';
import type { AnyAgentEvent } from '../../../events/agentEvents';
import type { LlmFallbackObserver } from '../../../llm';
import type {
  GraphExecutorContextBuilder,
  GraphExecutorContextBuildOutput,
} from '../../executorContextBuilder';
import { createApplySystemReminderStage } from '../stages/applySystemReminderStage';
import { createBuildContextStage } from '../stages/buildContextStage';
import { createBuildDecisionStage } from '../stages/buildDecisionStage';
import { createExecuteLlmStage } from '../stages/executeLlmStage';
import { createPrepareCallStage } from '../stages/prepareCallStage';
import type { TickPipelineContext, TickStage, TickStageContextKey, TickStagePatch } from '../types';
import { createTestTickPipelineContext } from './createTestTickPipelineContext';

type WritableStageField = TickStageContextKey;

interface RecordedContext {
  ctx: TickPipelineContext;
  writes: Set<string>;
}

function withRecordedWrites(ctx: TickPipelineContext): RecordedContext {
  const writes = new Set<string>();
  const proxy = new Proxy(ctx, {
    set(target, property, value, receiver) {
      if (typeof property === 'string') {
        writes.add(property);
      }
      return Reflect.set(target, property, value, receiver);
    },
  });
  return { ctx: proxy, writes };
}

async function runAndExpectWrites(
  stage: TickStage,
  ctx: TickPipelineContext
): Promise<Set<string>> {
  const recorded = withRecordedWrites(ctx);
  const patch = await stage.run(recorded.ctx);
  const observedWrites = new Set<string>([
    ...recorded.writes,
    ...Object.keys((patch ?? {}) as TickStagePatch),
  ]);
  const allowed = new Set<string>(stage.writes);
  const unexpected = [...observedWrites].filter(field => !allowed.has(field));
  expect(unexpected).toEqual([]);
  return observedWrites;
}

function expectWritesMatchDeclaration(
  stage: TickStage,
  actual: ReadonlySet<string>,
  nestedWrittenFields: readonly WritableStageField[] = []
): void {
  const observedWrites = new Set<string>([...actual, ...nestedWrittenFields]);
  expect([...observedWrites].sort()).toEqual([...stage.writes].sort());
}

function expectStageDeclaration(
  stage: TickStage,
  expected: {
    reads: readonly WritableStageField[];
    writes: readonly WritableStageField[];
  }
): void {
  expect(stage.reads).toEqual(expected.reads);
  expect(stage.writes).toEqual(expected.writes);
}

function createRequest(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    query: 'contract run',
    promptKey: 'default',
    model_id: 'requested-model',
    maxSteps: 8,
    enableTools: true,
    availableTools: ['document_lookup_tool'],
    ...overrides,
  };
}

describe('tick pipeline stage write contracts', () => {
  it('prepare_call 只写模型、工具与调用生命周期上下文', async () => {
    const toolSchema = {
      type: 'function' as const,
      function: {
        name: 'document_lookup_tool',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    };
    const ctx = createTestTickPipelineContext({
      request: createRequest(),
      context: {
        executorLocal: {
          stepCount: 2,
          llmInvocationKind: 'continuation',
          phase: 'force_tools',
        },
        conversationId: 'conv_prepare_contract',
        turnId: 'turn_prepare_contract',
      },
    });

    const stage = createPrepareCallStage({
      modelResolver: {
        resolveModelId: vi.fn(() => 'resolved-model'),
      },
      modelCatalog: {
        getModelById: vi.fn(() => undefined),
      },
      toolCatalog: {
        getToolSchemas: vi.fn(() => [toolSchema]),
        getToolDefinition: vi.fn(() => undefined),
      },
    });
    expectStageDeclaration(stage, {
      reads: [
        'request',
        'executorLocal',
        'forceFinalAnswer',
        'conversationId',
        'turnId',
        'input',
        'audit',
      ],
      writes: [
        'modelId',
        'toolSchemas',
        'toolModelInputRequirement',
        'toolCallStreamingPolicies',
        'llmOptions',
      ],
    });
    const writes = await runAndExpectWrites(stage, ctx);

    expectWritesMatchDeclaration(stage, writes);
  });

  it('build_context 只写 llmMessages、outputProcessor、contextTrace', async () => {
    const outputProcessor = {
      processResponse: (raw: string) => raw.trim(),
    };
    const contextBuilder: GraphExecutorContextBuilder = {
      build: vi.fn(async (): Promise<GraphExecutorContextBuildOutput> => {
        const llmMessages: LlmRequestMessage[] = [{ role: 'user', content: 'hello' }];
        return {
          llmMessages,
          summaryEvents: [],
          outputProcessor,
          contextTrace: {
            kind: 'contract',
            skipped: undefined,
          },
        };
      }),
    };
    const ctx = createTestTickPipelineContext({
      context: {
        modelId: 'context-model',
        signal: new AbortController().signal,
        summarizationCallbacks: {
          onSummarizationStart: vi.fn(),
        },
      },
    });

    const stage = createBuildContextStage({ contextBuilder });
    expectStageDeclaration(stage, {
      reads: [
        'request',
        'history',
        'summarizationCallbacks',
        'modelId',
        'signal',
        'telemetry',
        'conversationId',
        'turnId',
        'input',
        'eventHandler',
      ],
      writes: ['llmMessages', 'imageInputAdmissionEvidence', 'outputProcessor', 'contextTrace'],
    });
    const writes = await runAndExpectWrites(stage, ctx);

    expectWritesMatchDeclaration(stage, writes);
  });

  it('apply_system_reminder 只写 systemReminderHitRuleIds 和 llmMessages', async () => {
    const ctx = createTestTickPipelineContext({
      request: createRequest(),
      context: {
        llmMessages: [{ role: 'user', content: '需要调用工具' }],
        executorLocal: {
          stepCount: 1,
          systemReminderPolicy: {
            enabledRuleIds: ['last_steps_hint'],
            thresholds: { lastStepsHintThreshold: 2 },
          },
          phase: 'force_tools',
          remainingSteps: 1,
        },
      },
    });

    const stage = createApplySystemReminderStage();
    expectStageDeclaration(stage, {
      reads: ['llmMessages', 'request', 'history', 'executorLocal'],
      writes: ['systemReminderHitRuleIds', 'llmMessages'],
    });
    const writes = await runAndExpectWrites(stage, ctx);

    expectWritesMatchDeclaration(stage, writes);
  });

  it('execute_llm 只写 LLM 调用结果、计时与 fallback 审计字段', async () => {
    const fallbackAudit = {
      fromModelId: 'primary-model',
      toModelId: 'fallback-model',
      reason: 'quota exceeded',
      policy: 'cloud-quota' as const,
    };
    const ctx = createTestTickPipelineContext({
      context: {
        modelId: 'primary-model',
        llmMessages: [{ role: 'user', content: 'hello' }],
        llmOptions: {},
      },
    });

    const stage = createExecuteLlmStage({
      llmCaller: {
        callWithRetries: vi.fn(
          async (
            _modelId: string,
            _messages: LlmRequestMessage[],
            _options: unknown,
            _streamHandler: unknown,
            _signal: unknown,
            fallbackObserver?: LlmFallbackObserver
          ) => {
            fallbackObserver?.onCloudQuotaFallbackApplied?.('fallback-model');
            fallbackObserver?.onModelFallbackApplied?.(fallbackAudit);
            fallbackObserver?.onLlmAttemptSucceeded?.('fallback-model');
            return 'LLM response';
          }
        ),
      },
    });
    expectStageDeclaration(stage, {
      reads: [
        'input',
        'eventHandler',
        'outputProcessor',
        'modelId',
        'llmMessages',
        'toolModelInputRequirement',
        'toolCallStreamingPolicies',
        'imageInputAdmissionEvidence',
        'llmOptions',
        'signal',
        'audit',
        'conversationId',
        'turnId',
      ],
      writes: [
        'cloudQuotaFallbackAppliedModelId',
        'modelFallbackAudit',
        'llmCallStartedAt',
        'llmResp',
        'llmCallDurationMs',
        'executorLocalPatch',
      ],
    });
    const writes = await runAndExpectWrites(stage, ctx);

    expectWritesMatchDeclaration(stage, writes);
  });

  it('execute_llm 处理流式 chunk 时应保留 outputProcessor 方法上下文', async () => {
    const forwardedEvents: AnyAgentEvent[] = [];
    const outputProcessor = {
      prefix: 'processed',
      processStreamChunk(chunk: string): string {
        return `${this.prefix}:${chunk}`;
      },
    };
    const ctx = createTestTickPipelineContext({
      context: {
        input: {
          request: createRequest(),
          history: [],
          stream: true,
        },
        eventHandler: event => {
          forwardedEvents.push(event);
        },
        outputProcessor,
        modelId: 'stream-model',
        llmMessages: [{ role: 'user', content: 'hello' }],
        llmOptions: {},
      },
    });

    const stage = createExecuteLlmStage({
      llmCaller: {
        callWithRetries: vi.fn(
          async (
            _modelId: string,
            _messages: LlmRequestMessage[],
            _options: unknown,
            streamHandler?: (event: AnyAgentEvent) => void
          ) => {
            streamHandler?.({
              type: 'stream_chunk',
              id: 'chunk_1',
              timestamp: 1,
              answer_id: 'answer_1',
              seq: 0,
              content: 'hello',
            });
            return 'LLM response';
          }
        ),
      },
    });

    await stage.run(ctx);

    expect(forwardedEvents).toEqual([
      {
        type: 'stream_chunk',
        id: 'chunk_1',
        timestamp: 1,
        answer_id: 'answer_1',
        seq: 0,
        content: 'processed:hello',
      },
    ]);
  });

  it('execute_llm 在无兼容 fallback 并失败时仍记录拒绝审计', async () => {
    const providerError = new Error('provider failed');
    const audit = { emit: vi.fn() };
    const ctx = createTestTickPipelineContext({
      context: {
        modelId: 'primary-model',
        llmMessages: [{ role: 'user', content: '请分析图片' }],
        llmOptions: {},
        audit,
      },
    });
    const stage = createExecuteLlmStage({
      llmCaller: {
        callWithRetries: vi.fn(
          async (
            _modelId: string,
            _messages: LlmRequestMessage[],
            _options: unknown,
            _streamHandler: unknown,
            _signal: unknown,
            fallbackObserver?: LlmFallbackObserver
          ) => {
            fallbackObserver?.onModelFallbackRejected?.({
              fromModelId: 'primary-model',
              reason: 'no_eligible_fallback_candidate',
              policy: 'policy-switch',
              requiredPlacements: ['user_image'],
            });
            throw providerError;
          }
        ),
      },
    });

    await expect(stage.run(ctx)).rejects.toBe(providerError);
    expect(audit.emit).toHaveBeenCalledOnce();
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'model.fallback',
        decision: expect.objectContaining({
          outcome: 'denied',
          reason: 'no_eligible_fallback_candidate',
          metadata: {
            fromModelId: 'primary-model',
            requiredPlacements: ['user_image'],
          },
        }),
      })
    );
  });

  it('build_decision 只返回控制决策，运行事实统一交给 eventHandler', async () => {
    const ctx = createTestTickPipelineContext({
      context: {
        input: {
          request: createRequest({ enableTools: false }),
          history: [],
          stream: false,
        },
        request: createRequest({ enableTools: false }),
        llmResp: {
          content: 'Final answer.',
        },
        conversationId: 'conv_decision_contract',
        turnId: 'turn_decision_contract',
      },
    });

    const stage = createBuildDecisionStage();
    expectStageDeclaration(stage, {
      reads: ['llmResp', 'outputProcessor', 'forceFinalAnswer', 'eventHandler'],
      writes: ['decision'],
    });
    const writes = await runAndExpectWrites(stage, ctx);

    expectWritesMatchDeclaration(stage, writes);
  });
});
