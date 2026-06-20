import type { AnyAgentEvent } from '../events/agentEvents';
import { generateMessageId } from '../../shared/ids';
import type { AgentAiEngine } from '../../ports';
import { CanonicalLlmUsage } from '../../contracts';
import type { CanonicalLlmUsage as CanonicalLlmUsageType } from '../../contracts';
import type { LlmCallOptions, LlmRequestMessage, LlmResponseContent } from './caller.types';
import { ToolCallStreamAccumulator } from './streaming/toolCallStreamAccumulator';
import { ThoughtStreamSegmenter } from './streaming/thoughtStreamSegmenter';
import { assertToolCallsHaveValidJsonArguments, isRecord } from './sidecar-replay';
import type { LlmCallResult } from './usage-telemetry';
import { appendStreamingProviderReasoningDetails } from './reasoning-details';

export interface CallLlmStreamParams {
  aiEngine: AgentAiEngine;
  modelId: string;
  messages: LlmRequestMessage[];
  options?: LlmCallOptions;
  eventHandler: (event: AnyAgentEvent) => void;
  signal?: AbortSignal;
}

export async function callLlmStream(params: CallLlmStreamParams): Promise<LlmCallResult> {
  const {
    aiEngine,
    modelId,
    messages,
    options = {},
    eventHandler,
    signal,
  } = params;

  let fullResponse = '';
  let streamError: Error | null = null;
  let reasoningDetails: unknown[] = [];
  const streamAnswerId = generateMessageId();
  let streamChunkSeq = 0;
  let capturedUsage: unknown | undefined = undefined;
  let capturedCanonicalUsage: CanonicalLlmUsageType | undefined = undefined;

  const toolAccumulator = new ToolCallStreamAccumulator([
    'markdown_edit',
    'text_to_image',
    'ask_questions',
    'ppt_plan',
    'ppt_codegen',
  ]);
  const thoughtSegmenter = new ThoughtStreamSegmenter();

  const emitThoughtComplete = (completed: ReturnType<ThoughtStreamSegmenter['finalize']>): void => {
    if (!completed) return;
    eventHandler({
      type: 'thought',
      thought_message_id: completed.thoughtMessageId,
      id: generateMessageId(),
      timestamp: completed.timestamp,
      content: completed.content,
      is_complete: true,
      meta: {
        thought_started_at: completed.thoughtStartedAt,
        thought_completed_at: completed.thoughtCompletedAt,
      },
    });
  };

  const emitToolCallPlaceholder = (toolCallId: string, toolName: string): void => {
    if (!toolCallId || !toolName) return;
    eventHandler({
      type: 'tool_process',
      id: generateMessageId(),
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
      id: generateMessageId(),
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
      const compactedReasoningDetails = appendStreamingProviderReasoningDetails(reasoningDetails, newReasoningDetails);
      reasoningDetails = compactedReasoningDetails;
      const previousLastChanged =
        previousLength > 0 && compactedReasoningDetails[previousLength - 1] !== previousReasoningDetails[previousLength - 1];
      const emitFromIndex = previousLastChanged ? previousLength - 1 : previousLength;
      const emittedReasoningDetails = compactedReasoningDetails.slice(Math.max(0, emitFromIndex));
      if (emittedReasoningDetails.length > 0) {
        eventHandler({
          type: 'provider_sidecar',
          id: generateMessageId(),
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
            id: generateMessageId(),
            timestamp: Date.now(),
            tool_name: toolName,
            tool_args: args,
            tool_call_id: toolCallId,
            phase: 'update',
            status: 'loading',
            payload: { args },
            meta: { ephemeral: true },
          });
        },
      );
    }
  };

  const onError = (error: Error): void => {
    streamError = error;
    if (process.env.NODE_ENV !== 'production') {
      console.error('[LlmCaller][callStream] onError fired', {
        modelId,
        messageCount: Array.isArray(messages) ? messages.length : -1,
        errorMessage: error?.message,
      });
    }
    eventHandler({
      type: 'error',
      error: error.message,
      details: error.stack,
      timestamp: Date.now(),
      id: generateMessageId(),
    });
  };

  const onFinish = (_reason: string): void => {
    // onFinish 不发送事件，由 stream_end 信号处理。
  };

  const onThought = (thought: string): void => {
    const delta = thoughtSegmenter.onThoughtDelta(thought);
    if (!delta) return;

    eventHandler({
      type: 'thought',
      thought_message_id: delta.thoughtMessageId,
      id: generateMessageId(),
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
    onCanonicalUsage,
  );

  if (streamError) {
    throw streamError;
  }

  emitThoughtComplete(thoughtSegmenter.finalize());

  const mergedToolCalls = toolAccumulator.getToolCalls();
  assertToolCallsHaveValidJsonArguments(mergedToolCalls);
  if (
    mergedToolCalls.length > 0
    || reasoningDetails.length > 0
    || capturedUsage !== undefined
    || capturedCanonicalUsage !== undefined
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
