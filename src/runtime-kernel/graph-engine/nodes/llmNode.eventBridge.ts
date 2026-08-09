import type { AnyAgentEvent } from '../../events/agentEvents';
import { eventMapper } from '../../events/eventMappers';
import {
  createStandaloneFinalAnswerChunk,
  FinalAnswerAssembler,
} from '../../events/finalAnswerAssembler';
import type { LlmNodeLocalState, LlmNodeAction } from './llmNode.state';
import {
  toSerializableJsonValue,
  type FinalAnswerCompletionReason,
  type ProviderReasoningDetailsPayload,
  type RoutedRuntimeEvent,
  type RuntimeEvent,
} from '../../../contracts';
import type { RuntimeEventSink } from '../types';

export type TickEvent = AnyAgentEvent | RuntimeEvent;

function serializeReasoningDetails(value: unknown): ProviderReasoningDetailsPayload | undefined {
  if (!Array.isArray(value)) return undefined;
  const serialized = value
    .map(item => toSerializableJsonValue(item))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);
  return serialized.length > 0 ? serialized : undefined;
}

export interface LlmNodeEventBridgeDeps {
  getState: () => LlmNodeLocalState;
  dispatch: (action: LlmNodeAction) => void;
  runtimeEventSink: RuntimeEventSink;
  conversationId: string;
  turnId: string;
}

/** 将 provider/LLM 事件一次映射为 RuntimeEvent，并同步写入发布流与 graph journal。 */
export class LlmNodeEventBridge {
  private readonly assembler = new FinalAnswerAssembler();

  constructor(private readonly deps: LlmNodeEventBridgeDeps) {}

  handle = (agentEvent: TickEvent): void => {
    if (!agentEvent || typeof agentEvent !== 'object') return;

    if (agentEvent.type === 'provider_sidecar') {
      return;
    }

    if (agentEvent.type === 'stream_chunk') {
      this.handleStreamChunk(agentEvent);
      return;
    }

    if (agentEvent.type === 'stream_reset') {
      this.assembler.reset();
      this.deps.dispatch({ type: 'STREAM_RESET' });
      this.mapPublishAndBuffer(agentEvent, 'LlmNode.stream_reset');
      return;
    }

    if (agentEvent.type === 'tool_call_decision') {
      this.publishAssembledAnswer({
        completionReason: 'tool_call',
        reasoningDetails: serializeReasoningDetails(agentEvent.payload?.reasoning_details),
      });
      this.mapPublishAndBuffer(agentEvent, 'LlmNode.tool_call_decision');
      return;
    }

    if (agentEvent.type === 'final_answer') {
      if (this.assembler.hasContent()) {
        this.publishAssembledAnswer({
          completionReason: 'terminal',
          reasoningDetails: serializeReasoningDetails(agentEvent.reasoning_details),
        });
      } else {
        const finalAnswer = this.mapRuntimeEvent(agentEvent);
        if (!finalAnswer || finalAnswer.type !== 'final_answer') {
          throw new Error('final_answer did not map to a final_answer RuntimeEvent.');
        }
        const liveChunk = createStandaloneFinalAnswerChunk(finalAnswer);
        this.deps.dispatch({
          type: 'STREAM_CHUNK_RECEIVED',
          answerId: liveChunk.answer_id,
          seq: liveChunk.seq,
        });
        this.buffer(this.publish(liveChunk, 'LlmNode.final_answer_chunk.standalone'));
        this.buffer(this.publish(finalAnswer, 'LlmNode.final_answer'));
      }
      this.deps.dispatch({ type: 'FINAL_ANSWER_RECEIVED' });
      return;
    }

    this.mapPublishAndBuffer(agentEvent, `LlmNode.${agentEvent.type}`);
  };

  finalizePartialAnswer(): void {
    this.publishAssembledAnswer({ completionReason: 'interrupted' });
  }

  private handleStreamChunk(agentEvent: Extract<TickEvent, { type: 'stream_chunk' }>): void {
    const runtimeEvent = this.mapRuntimeEvent(agentEvent);
    if (!runtimeEvent || runtimeEvent.type !== 'final_answer_chunk') {
      throw new Error('stream_chunk did not map to final_answer_chunk.');
    }
    this.deps.dispatch({
      type: 'STREAM_CHUNK_RECEIVED',
      answerId: runtimeEvent.answer_id,
      seq: runtimeEvent.seq,
    });
    const published = this.publish(runtimeEvent, 'LlmNode.final_answer_chunk');
    if (published.type !== 'final_answer_chunk') {
      throw new Error('RuntimeEvent sink changed final_answer_chunk type.');
    }
    this.assembler.push(published);
    this.buffer(published);
  }

  private publishAssembledAnswer(options: {
    completionReason: FinalAnswerCompletionReason;
    reasoningDetails?: ProviderReasoningDetailsPayload;
  }): void {
    const event = this.assembler.finalize(options);
    if (!event) return;
    this.buffer(this.publish(event, 'LlmNode.final_answer'));
  }

  private mapPublishAndBuffer(agentEvent: TickEvent, source: string): void {
    const event = this.mapRuntimeEvent(agentEvent);
    if (!event) return;
    this.buffer(this.publish(event, source));
  }

  private mapRuntimeEvent(agentEvent: TickEvent): RuntimeEvent | null {
    return eventMapper.agentToRuntime(agentEvent, {
      conversationId: this.deps.conversationId,
      turnId: this.deps.turnId,
    }, { skipIncomplete: false });
  }

  private publish(event: RuntimeEvent, source: string): RoutedRuntimeEvent {
    return this.deps.runtimeEventSink(event, source);
  }

  private buffer(event: RoutedRuntimeEvent): void {
    this.deps.dispatch({ type: 'RUNTIME_EVENT_BUFFERED', event });
  }
}
