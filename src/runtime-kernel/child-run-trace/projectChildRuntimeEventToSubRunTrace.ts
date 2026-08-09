import type { RoutedRuntimeEvent } from '../../contracts';
import type { SubRunTraceEnvelope } from './subrunTrace.types';

/**
 * parent trace 是 child fact 的展示投影。该函数只做语义选择与字段映射，
 * 不拥有 child admission、parent 发布、持久化或事件 ID。
 */
export function projectChildRuntimeEventToSubRunTrace(
  event: RoutedRuntimeEvent,
): SubRunTraceEnvelope | null {
  switch (event.type) {
    case 'thought':
      return event.is_complete
        ? {
            kind: 'thought_complete',
            source_event_id: event.id,
            content: event.content,
          }
        : {
            kind: 'thought_delta',
            source_event_id: event.id,
            delta: event.delta ?? event.content,
          };
    case 'tool_call_decision':
    case 'tool_process':
      return {
        kind: event.type,
        source_event_id: event.id,
        tool_name: event.tool_name,
        tool_call_id: event.tool_call_id,
        phase: event.phase,
        status: event.status,
        ...(event.args === undefined ? {} : { args: event.args }),
      };
    case 'tool_output':
      return {
        kind: 'tool_output',
        source_event_id: event.id,
        tool_name: event.tool_name,
        tool_call_id: event.tool_call_id,
        status: event.status,
        output: event.status === 'success'
          ? {
              data: event.data ?? null,
              observation: event.observation,
              ...(typeof event.metadata?.presentation === 'object'
                && event.metadata.presentation !== null
                && !Array.isArray(event.metadata.presentation)
                ? event.metadata.presentation
                : {}),
            }
          : {
              error: event.error,
              observation: event.observation,
            },
        ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
      };
    case 'final_answer_chunk':
      return {
        kind: 'final_answer_chunk',
        source_event_id: event.id,
        answer_id: event.answer_id,
        seq: event.seq,
        delta: event.content,
        ...(event.is_last === undefined ? {} : { is_last: event.is_last }),
      };
    case 'final_answer':
      return {
        kind: 'final_answer',
        source_event_id: event.id,
        answer_id: event.answer_id,
        content: event.content,
        completion_reason: event.completion_reason,
      };
    default:
      return null;
  }
}
