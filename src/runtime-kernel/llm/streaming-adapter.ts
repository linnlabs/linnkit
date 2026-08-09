import type { AnyAgentEvent } from '../events/agentEvents';
import { generateAnswerSegmentId, generateRuntimeEventId } from '../../contracts';
import type { AgentAiEngine } from '../../ports';
import { CanonicalLlmUsage } from '../../contracts';
import type { CanonicalLlmUsage as CanonicalLlmUsageType } from '../../contracts';
import type { ToolCallId } from '../../contracts';
import type { LlmCallOptions, LlmResponseContent } from './caller.types';
import type { ResolvedLlmInputMessage } from '../../ports';
import { ToolCallStreamAccumulator } from './streaming/toolCallStreamAccumulator';
import { ThoughtStreamSegmenter } from './streaming/thoughtStreamSegmenter';
import { assertToolCallsHaveValidJsonArguments, isRecord } from './sidecar-replay';
import type { LlmCallResult } from './usage-telemetry';
import { appendStreamingProviderReasoningDetails } from './reasoning-details';
import { Logger } from '../../shared/logger';
import { ErrorClassifier, type ErrorClassification } from '../../shared/errorClassifier';
import { createLlmAgentErrorEvent } from './functions/createLlmAgentErrorEvent';
import type { ToolCallStreamingPolicy } from '../tools/toolContracts';

const logger = new Logger('LlmCaller');

export interface CallLlmStreamParams {
  aiEngine: AgentAiEngine;
  modelId: string;
  messages: ResolvedLlmInputMessage[];
  options?: LlmCallOptions;
  eventHandler: (event: AnyAgentEvent) => void;
  onErrorClassification?: (classification: ErrorClassification) => void;
  signal?: AbortSignal;
  toolCallStreamingPolicies?: Readonly<Record<string, ToolCallStreamingPolicy>>;
}

export async function callLlmStream(params: CallLlmStreamParams): Promise<LlmCallResult> {
  const {
    aiEngine,
    modelId,
    messages,
    options = {},
    eventHandler,
    onErrorClassification,
    signal,
    toolCallStreamingPolicies = {},
  } = params;

  let fullResponse = '';
  let streamError: Error | null = null;
  let reasoningDetails: unknown[] = [];
  const streamAnswerId = generateAnswerSegmentId();
  let streamChunkSeq = 0;
  let capturedUsage: unknown | undefined = undefined;
  let capturedCanonicalUsage: CanonicalLlmUsageType | undefined = undefined;

  const toolAccumulator = new ToolCallStreamAccumulator(toolCallStreamingPolicies);
  const thoughtSegmenter = new ThoughtStreamSegmenter();

  const emitThoughtComplete = (completed: ReturnType<ThoughtStreamSegmenter['finalize']>): void => {
    if (!completed) return;
    eventHandler({
      type: 'thought',
      thought_message_id: completed.thoughtMessageId,
      id: generateRuntimeEventId(),
      timestamp: completed.timestamp,
      content: completed.content,
      is_complete: true,
      meta: {
        thought_started_at: completed.thoughtStartedAt,
        thought_completed_at: completed.thoughtCompletedAt,
      },
    });
  };

  const emitToolCallPlaceholder = (toolCallId: ToolCallId, toolName: string): void => {
    if (!toolCallId || !toolName) return;
    eventHandler({
      type: 'tool_process',
      id: generateRuntimeEventId(),
      timestamp: Date.now(),
      tool_name: toolName,
      tool_args: {},
      tool_call_id: toolCallId,
      phase: 'start',
      status: 'loading',
      payload: { args: {} },
      meta: { ephemeral: true },
    });
  };

  const emitStreamChunk = (content: string): void => {
    eventHandler({
      type: 'stream_chunk',
      timestamp: Date.now(),
      content,
      id: generateRuntimeEventId(),
      answer_id: streamAnswerId,
      seq: streamChunkSeq++,
    });
  };

  const onContent = (chunk: string | LlmResponseContent): void => {
    if (typeof chunk === 'string') {
      emitThoughtComplete(thoughtSegmenter.onBoundary());
      fullResponse += chunk;
      emitStreamChunk(chunk);
      return;
    }

    if (typeof chunk !== 'object' || chunk === null) {
      return;
    }

    const parsedCanonicalUsage = CanonicalLlmUsage.safeParse(chunk.canonicalUsage);
    if (parsedCanonicalUsage.success) {
      capturedCanonicalUsage = parsedCanonicalUsage.data;
    }

    if (chunk.content) {
      emitThoughtComplete(thoughtSegmenter.onBoundary());
      fullResponse += chunk.content;
      emitStreamChunk(chunk.content);
    }

    const reasoning = isRecord(chunk) ? chunk['reasoning_details'] : undefined;
    if (reasoning !== undefined) {
      const newReasoningDetails = Array.isArray(reasoning) ? reasoning : [reasoning];
      const previousReasoningDetails = reasoningDetails;
      const previousLength = previousReasoningDetails.length;
      const compactedReasoningDetails = appendStreamingProviderReasoningDetails(
        reasoningDetails,
        newReasoningDetails
      );
      reasoningDetails = compactedReasoningDetails;
      const previousLastChanged =
        previousLength > 0 &&
        compactedReasoningDetails[previousLength - 1] !==
          previousReasoningDetails[previousLength - 1];
      const emitFromIndex = previousLastChanged ? previousLength - 1 : previousLength;
      const emittedReasoningDetails = compactedReasoningDetails.slice(Math.max(0, emitFromIndex));
      if (emittedReasoningDetails.length > 0) {
        eventHandler({
          type: 'provider_sidecar',
          id: generateRuntimeEventId(),
          timestamp: Date.now(),
          reasoning_details: emittedReasoningDetails,
        });
      }
    }

    if (chunk.tool_calls) {
      emitThoughtComplete(thoughtSegmenter.onBoundary());
      toolAccumulator.applyChunks(
        chunk.tool_calls,
        emitToolCallPlaceholder,
        (toolCallId, toolName, args) => {
          eventHandler({
            type: 'tool_process',
            id: generateRuntimeEventId(),
            timestamp: Date.now(),
            tool_name: toolName,
            tool_args: args,
            tool_call_id: toolCallId,
            phase: 'update',
            status: 'loading',
            payload: { args },
            meta: { ephemeral: true },
          });
        }
      );
    }
  };

  const onError = (error: Error): void => {
    streamError = error;
    if (error.name === 'AbortError') {
      logger.info('LLM 流收到 AbortError，不发布普通 error event', {
        modelId,
        reason: signal?.reason,
      });
      return;
    }
    const classification = ErrorClassifier.classify(error, { logPrefix: '[LlmCaller:stream]' });
    onErrorClassification?.(classification);
    if (process.env.NODE_ENV !== 'production') {
      logger.error('callStream onError fired', {
        modelId,
        messageCount: Array.isArray(messages) ? messages.length : -1,
        errorMessage: error?.message,
      });
    }
    eventHandler(createLlmAgentErrorEvent(error, classification));
  };

  const onFinish = (_reason: string): void => {
    // onFinish 不发送运行或传输终态；两者分别由 Host settlement 与 transport owner 处理。
  };

  const onThought = (thought: string): void => {
    const delta = thoughtSegmenter.onThoughtDelta(thought);
    if (!delta) return;

    eventHandler({
      type: 'thought',
      thought_message_id: delta.thoughtMessageId,
      id: generateRuntimeEventId(),
      timestamp: delta.timestamp,
      content: '',
      delta: delta.delta,
      is_complete: false,
      meta: {
        thought_started_at: delta.thoughtStartedAt,
      },
    });
  };

  const onUsage = (usage: unknown): void => {
    capturedUsage = usage;
  };

  const onCanonicalUsage = (usage: CanonicalLlmUsageType): void => {
    const parsed = CanonicalLlmUsage.safeParse(usage);
    if (parsed.success) {
      capturedCanonicalUsage = parsed.data;
    }
  };

  try {
    await aiEngine.chatCompletionStream(
      modelId,
      messages,
      {
        ...options,
        signal,
        stream_options: { include_usage: true },
      },
      onContent,
      onError,
      onFinish,
      onThought,
      onUsage,
      onCanonicalUsage
    );
  } finally {
    // Provider 正常完成、回调报错和用户取消都结束了当前 thought 段。
    // 必须在 provider 边界封口，不能让 Renderer 根据 transport/run 状态猜测。
    emitThoughtComplete(thoughtSegmenter.finalize());
  }

  if (streamError) {
    throw streamError;
  }

  const mergedToolCalls = toolAccumulator.getToolCalls();
  assertToolCallsHaveValidJsonArguments(mergedToolCalls);
  if (
    mergedToolCalls.length > 0 ||
    reasoningDetails.length > 0 ||
    capturedUsage !== undefined ||
    capturedCanonicalUsage !== undefined
  ) {
    return {
      content: fullResponse,
      tool_calls: mergedToolCalls,
      reasoning_details: reasoningDetails.length > 0 ? reasoningDetails : undefined,
      ...(capturedUsage !== undefined ? { usage: capturedUsage } : {}),
      ...(capturedCanonicalUsage !== undefined ? { canonicalUsage: capturedCanonicalUsage } : {}),
    };
  }

  return fullResponse;
}
