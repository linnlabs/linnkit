import {
  AnyAgentEvent,
  ErrorEvent as AgentErrorEvent,
  FinalAnswerEvent as AgentFinalAnswerEvent,
  ObservationEvent as AgentObservationEvent,
  StreamChunkEvent as AgentStreamChunkEvent,
  ThoughtEvent as AgentThoughtEvent,
  ToolCallDecisionEvent as AgentToolCallDecisionEvent,
  ToolProcessEvent as AgentToolProcessEvent,
  isMarkedAsSseDispatched,
  readAgentEventAnswerId,
  readAgentEventSeq,
} from './agentEvents';
import {
  createSSEErrorEvent,
  createSSEFinalAnswerChunkEvent,
  createSSEFinalAnswerEvent,
  createSSEThoughtEvent,
  createSSEToolCallDecisionEvent,
  createSSEToolOutputEvent,
  createSSEToolProcessEvent,
  type SSEEvent,
} from '../../contracts';
import { generateMessageId } from '../../shared/ids';
import {
  type EventMappingContext,
  type SSEMappingOptions,
  isRecord,
  readAnswerIdFromEvent,
  readMetaFromEvent,
  resolveToolDisplayOptions,
} from './provider-sidecar';

export function agentEventToSSE(
  agentEvent: AnyAgentEvent,
  context: EventMappingContext,
  options: SSEMappingOptions = {},
): SSEEvent | null {
  if (!agentEvent || typeof agentEvent !== 'object') return null;
  if (options.skipAlreadyDispatched && isMarkedAsSseDispatched(agentEvent)) return null;

  const { conversationId, turnId } = context;
  const timestamp = agentEvent.timestamp ?? context.timestamp ?? Date.now();
  const id = agentEvent.id ?? generateMessageId();
  const contextMeta = context.metadata;

  switch (agentEvent.type) {
    case 'thought': {
      const thoughtEvent = agentEvent as AgentThoughtEvent;
      const rawContent = 'content' in thoughtEvent ? thoughtEvent.content : '';
      const delta = 'delta' in thoughtEvent ? thoughtEvent.delta : '';
      const isComplete = 'is_complete' in thoughtEvent ? Boolean(thoughtEvent.is_complete) : false;
      const thoughtMessageId =
        typeof thoughtEvent.thought_message_id === 'string' && thoughtEvent.thought_message_id.length > 0
          ? thoughtEvent.thought_message_id
          : undefined;

      const sse = createSSEThoughtEvent(id, conversationId, turnId, {
        thought_message_id: thoughtMessageId,
        content: isComplete ? (rawContent ?? '') : undefined,
        delta: !isComplete ? (delta ?? rawContent) : undefined,
        is_complete: isComplete,
      });
      sse.timestamp = timestamp;
      const thoughtMeta = isRecord(thoughtEvent.meta) ? thoughtEvent.meta : undefined;
      if (contextMeta || thoughtMeta) {
        sse.metadata = { ...(contextMeta ?? {}), ...(thoughtMeta ?? {}) };
      }
      return sse;
    }

    case 'tool_call_decision':
    case 'tool_process':
      return mapToolProgressToSse(agentEvent, context, options, id, timestamp);

    case 'observation': {
      const observationEvent = agentEvent as AgentObservationEvent;
      const toolName = observationEvent.tool_name || 'unknown_tool';
      const toolCallId = observationEvent.tool_call_id || `call_${id}`;
      const status: 'success' | 'error' = observationEvent.success === false ? 'error' : 'success';
      const payload = observationEvent.payload || {};
      const duration = payload.duration_ms as number | undefined;
      const sse = createSSEToolOutputEvent(
        id,
        conversationId,
        turnId,
        toolName,
        toolCallId,
        status,
        observationEvent.output,
        { timestamp, payload, duration_ms: duration },
      );
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    case 'stream_chunk': {
      const streamEvent = agentEvent as AgentStreamChunkEvent;
      const text = streamEvent.content ?? '';
      if (!text) return null;
      const answerId = readAgentEventAnswerId(streamEvent) ?? `answer_${turnId}`;
      const seq = readAgentEventSeq(streamEvent) ?? 0;
      const isLast = Boolean(
        ('isLast' in streamEvent && streamEvent.isLast) ||
        ('is_last' in streamEvent && streamEvent.is_last),
      );
      const sse = createSSEFinalAnswerChunkEvent(id, conversationId, turnId, answerId, seq, text, {
        is_last: isLast,
      });
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    case 'final_answer': {
      const finalAnswerEvent = agentEvent as AgentFinalAnswerEvent;
      const answer = finalAnswerEvent.answer ?? '';
      const answerIdFromSnake =
        typeof finalAnswerEvent.answer_id === 'string' && finalAnswerEvent.answer_id.trim().length > 0
          ? finalAnswerEvent.answer_id.trim()
          : undefined;
      const answerId = answerIdFromSnake ?? readAnswerIdFromEvent(finalAnswerEvent) ?? `answer_${turnId}`;
      const sse = createSSEFinalAnswerEvent(id, conversationId, turnId, answerId, answer, {
        meta: readMetaFromEvent(finalAnswerEvent),
      });
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    case 'error': {
      const errorEvent = agentEvent as AgentErrorEvent;
      const sse = createSSEErrorEvent(id, conversationId, turnId, errorEvent.error ?? 'Unknown error', {
        details: errorEvent.details,
      });
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    default:
      return null;
  }
}

function mapToolProgressToSse(
  agentEvent: AgentToolCallDecisionEvent | AgentToolProcessEvent,
  context: EventMappingContext,
  options: SSEMappingOptions,
  id: string,
  timestamp: number,
): SSEEvent {
  const toolName = agentEvent.tool_name || 'unknown_tool';
  const toolCallId = agentEvent.tool_call_id || `call_${id}`;
  const phase = agentEvent.phase ?? 'start';
  const status = agentEvent.status ?? 'loading';
  const args = agentEvent.tool_args || {};
  const payload = agentEvent.payload || {};
  const meta = agentEvent.meta && typeof agentEvent.meta === 'object' ? { ...agentEvent.meta } : {};
  const displayOptions = resolveToolDisplayOptions(toolName, options.toolPresentationPort);
  if (displayOptions && !meta.displayOptions) meta.displayOptions = displayOptions;

  const sse = agentEvent.type === 'tool_call_decision'
    ? createSSEToolCallDecisionEvent(id, context.conversationId, context.turnId, toolName, toolCallId, phase, status, {
        timestamp,
        args,
        payload,
        meta,
      })
    : createSSEToolProcessEvent(id, context.conversationId, context.turnId, toolName, toolCallId, phase, status, {
        timestamp,
        args,
        payload,
        meta,
      });
  sse.timestamp = timestamp;
  if (context.metadata) sse.metadata = context.metadata;
  return sse;
}
