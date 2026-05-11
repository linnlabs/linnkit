import {
  AnyAgentEvent,
  ErrorEvent as AgentErrorEvent,
  FinalAnswerEvent as AgentFinalAnswerEvent,
  ObservationEvent as AgentObservationEvent,
  StreamChunkEvent as AgentStreamChunkEvent,
  ThoughtEvent as AgentThoughtEvent,
  ToolCallDecisionEvent as AgentToolCallDecisionEvent,
  ToolProcessEvent as AgentToolProcessEvent,
  readAgentEventAnswerId,
  readAgentEventSeq,
} from './agentEvents';
import {
  RuntimeEvent,
  createErrorEvent,
  createFinalAnswerChunkEvent,
  createFinalAnswerEvent,
  createThoughtEvent,
  createToolCallDecisionEvent,
  createToolOutputEvent,
  createToolProcessEvent,
} from '../../contracts';
import { generateMessageId } from '../../shared/ids';
import {
  type EventMappingContext,
  type RuntimeMappingOptions,
  isRecord,
  readAnswerIdFromEvent,
  readMetaFromEvent,
  resolveToolDisplayOptions,
} from './provider-sidecar';

export function agentEventToRuntime(
  agentEvent: AnyAgentEvent | RuntimeEvent,
  context: EventMappingContext,
  options: RuntimeMappingOptions = {},
): RuntimeEvent | null {
  if (!agentEvent || typeof agentEvent !== 'object') return null;

  if (isRecord(agentEvent) && agentEvent['type'] === 'history_summary') {
    const evt = agentEvent as RuntimeEvent;
    if (context.metadata) {
      evt.metadata = { ...(evt.metadata ?? {}), ...context.metadata };
    }
    return evt;
  }

  const typed = agentEvent as AnyAgentEvent;
  const { conversationId, turnId } = context;
  const timestamp = typed.timestamp ?? context.timestamp ?? Date.now();
  const id = typed.id ?? generateMessageId();
  const contextMeta = context.metadata;

  switch (typed.type) {
    case 'thought':
      return mapThoughtToRuntime(typed as AgentThoughtEvent, context, options, id, timestamp);

    case 'tool_call_decision':
    case 'tool_process':
      return mapToolProgressToRuntime(typed, context, options, id, timestamp);

    case 'observation': {
      const observationEvent = typed as AgentObservationEvent;
      const toolName = observationEvent.tool_name || 'unknown_tool';
      const toolCallId = observationEvent.tool_call_id || `call_${id}`;
      const success = observationEvent.success ?? !/^错误[:：]/i.test(String(observationEvent.output ?? ''));
      const payload = observationEvent.payload || {};
      const event = createToolOutputEvent(
        id,
        conversationId,
        turnId,
        toolName,
        toolCallId,
        observationEvent.output,
        success ? 'success' : 'error',
        { timestamp, payload, duration_ms: payload.duration_ms as number | undefined },
      );
      event.ephemeral = false;
      if (contextMeta) event.metadata = { ...(event.metadata ?? {}), ...contextMeta };
      return event;
    }

    case 'final_answer': {
      const finalAnswerEvent = typed as AgentFinalAnswerEvent;
      const answerIdFromSnake =
        typeof finalAnswerEvent.answer_id === 'string' && finalAnswerEvent.answer_id.trim().length > 0
          ? finalAnswerEvent.answer_id.trim()
          : undefined;
      return createFinalAnswerEvent(
        id,
        conversationId,
        turnId,
        answerIdFromSnake ?? readAnswerIdFromEvent(finalAnswerEvent) ?? `answer_${turnId}`,
        finalAnswerEvent.answer ?? '',
        {
          timestamp,
          reasoning_details: Array.isArray(finalAnswerEvent.reasoning_details)
            ? finalAnswerEvent.reasoning_details
            : undefined,
          meta: readMetaFromEvent(finalAnswerEvent),
        },
      );
    }

    case 'error': {
      const errorEvent = typed as AgentErrorEvent;
      return createErrorEvent(id, conversationId, turnId, errorEvent.error ?? 'Unknown error', {
        timestamp,
        details: errorEvent.details,
      });
    }

    case 'stream_chunk':
      return mapStreamChunkToRuntime(typed as AgentStreamChunkEvent, context, id, timestamp);

    default:
      return null;
  }
}

function mapThoughtToRuntime(
  thoughtEvent: AgentThoughtEvent,
  context: EventMappingContext,
  options: RuntimeMappingOptions,
  id: string,
  timestamp: number,
): RuntimeEvent | null {
  const isComplete = 'is_complete' in thoughtEvent ? Boolean(thoughtEvent.is_complete) : false;
  if (options.skipIncomplete && !isComplete) return null;

  const thoughtMessageId =
    typeof thoughtEvent.thought_message_id === 'string' && thoughtEvent.thought_message_id.length > 0
      ? thoughtEvent.thought_message_id
      : undefined;
  const runtimeEvent = createThoughtEvent(id, context.conversationId, context.turnId, thoughtEvent.content ?? '', {
    timestamp,
    thought_message_id: thoughtMessageId,
    delta: thoughtEvent.delta,
    is_complete: isComplete,
  });
  if (!isComplete) runtimeEvent.ephemeral = true;
  const thoughtMeta = isRecord(thoughtEvent.meta) ? thoughtEvent.meta : undefined;
  if (context.metadata || thoughtMeta) {
    runtimeEvent.metadata = { ...(runtimeEvent.metadata ?? {}), ...(context.metadata ?? {}), ...(thoughtMeta ?? {}) };
  }
  return runtimeEvent;
}

function mapToolProgressToRuntime(
  toolEvent: AgentToolCallDecisionEvent | AgentToolProcessEvent,
  context: EventMappingContext,
  options: RuntimeMappingOptions,
  id: string,
  timestamp: number,
): RuntimeEvent {
  const toolName = toolEvent.tool_name || 'unknown_tool';
  const toolCallId = toolEvent.tool_call_id || `call_${id}`;
  const meta = toolEvent.meta && typeof toolEvent.meta === 'object' ? { ...toolEvent.meta } : {};
  const displayOptions = resolveToolDisplayOptions(toolName, options.toolPresentationPort);
  if (displayOptions && !meta.displayOptions) meta.displayOptions = displayOptions;

  const event = toolEvent.type === 'tool_call_decision'
    ? createToolCallDecisionEvent(id, context.conversationId, context.turnId, toolName, toolCallId, {
        timestamp,
        phase: toolEvent.phase ?? 'start',
        status: toolEvent.status ?? 'loading',
        args: toolEvent.tool_args || {},
        payload: toolEvent.payload || {},
        meta,
      })
    : createToolProcessEvent(id, context.conversationId, context.turnId, toolName, toolCallId, {
        timestamp,
        phase: toolEvent.phase ?? 'start',
        status: toolEvent.status ?? 'loading',
        args: toolEvent.tool_args || {},
        payload: toolEvent.payload || {},
        meta,
      });
  event.ephemeral = meta.ephemeral === true;
  if (context.metadata) event.metadata = { ...(event.metadata ?? {}), ...context.metadata };
  return event;
}

function mapStreamChunkToRuntime(
  streamEvent: AgentStreamChunkEvent,
  context: EventMappingContext,
  id: string,
  timestamp: number,
): RuntimeEvent | null {
  const text = streamEvent.content ?? '';
  if (!text) return null;
  const answerId = readAgentEventAnswerId(streamEvent) ?? `answer_${context.turnId}`;
  const seq = readAgentEventSeq(streamEvent) ?? 0;
  const isLast = Boolean(
    ('isLast' in streamEvent && streamEvent.isLast) ||
    ('is_last' in streamEvent && streamEvent.is_last),
  );
  const chunkEvent = createFinalAnswerChunkEvent(id, context.conversationId, context.turnId, answerId, seq, text, {
    timestamp,
    is_last: isLast,
  });
  chunkEvent.ephemeral = true;
  if (context.metadata) chunkEvent.metadata = { ...(chunkEvent.metadata ?? {}), ...context.metadata };
  return chunkEvent;
}
