import { describe, expect, it } from 'vitest';
import {
  getRuntimeEventUiProjectionKind,
  shouldEnterAgentContext,
  shouldEmitRuntimeEventToSse,
  shouldPersistRuntimeEvent,
  shouldReplayRuntimeEventToUi,
} from '../eventGovernance';
import { validateRuntimeEvent } from '../../../contracts';
import type { RuntimeEvent } from '../../../contracts';

function createBaseEvent(
  event: Record<string, unknown> & { id: string; type: RuntimeEvent['type'] },
): RuntimeEvent {
  const candidate = {
    ...event,
    conversation_id: 'conv_contract',
    turn_id: 'turn_contract',
    timestamp: 1,
    version: 1,
  };
  const parsed = validateRuntimeEvent(candidate);
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

describe('eventGovernance contract', () => {
  it('tool_call_decision 应进入 persist / replay / context', () => {
    const event = createBaseEvent({
      type: 'tool_call_decision',
      id: 'decision_1',
      tool_name: 'web_search',
      tool_call_id: 'call_1',
      phase: 'start',
      status: 'loading',
      args: { query: 'AI' },
      payload: {
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"AI"}' },
          },
        ],
      },
    });

    expect(shouldPersistRuntimeEvent(event)).toBe(true);
    expect(shouldReplayRuntimeEventToUi(event)).toBe(true);
    expect(shouldEnterAgentContext(event)).toBe(true);
  });

  it('stream_end 应持久化/可回放，但不应进入上下文（避免生成空白消息）', () => {
    const event = createBaseEvent({
      type: 'stream_end',
      id: 'end_1',
      reason: 'complete',
      stats: { duration_ms: 123 },
    });

    expect(shouldPersistRuntimeEvent(event)).toBe(true);
    expect(shouldReplayRuntimeEventToUi(event)).toBe(true);
    expect(shouldEnterAgentContext(event)).toBe(false);
  });

  it('tool_process 应为 UI-only：不持久化、不进上下文、但允许回放层消费', () => {
    const event = createBaseEvent({
      type: 'tool_process',
      id: 'process_1',
      tool_name: 'web_search',
      tool_call_id: 'call_1',
      phase: 'update',
      status: 'loading',
      args: { query: 'AI' },
      payload: { args: { query: 'AI' } },
    });

    expect(shouldPersistRuntimeEvent(event)).toBe(false);
    expect(shouldReplayRuntimeEventToUi(event)).toBe(true);
    expect(shouldEnterAgentContext(event)).toBe(false);
  });

  it('todo_updated / subrun_trace / hidden user_input 不应进入上下文', () => {
    const todoEvent = createBaseEvent({
      type: 'todo_updated',
      id: 'todo_1',
      todo_list_id: 'todo_list_1',
      todo_list_version: 1,
      items: [{ id: 'item_1', content: '整理结果', status: 'in_progress' }],
    });
    const subrunEvent = createBaseEvent({
      type: 'subrun_trace',
      id: 'subrun_1',
      parent_tool_call_id: 'call_parent',
      subrun_id: 'sub_1',
      kind: 'tool_process',
      tool_name: 'task',
      tool_call_id: 'call_child',
      phase: 'start',
      status: 'loading',
    });
    const hiddenUserInput = createBaseEvent({
      type: 'user_input',
      id: 'hidden_user_1',
      content: '内部推进',
      source: 'user',
      metadata: {
        ui: {
          presentation: 'hidden',
        },
      },
    });

    expect(shouldEnterAgentContext(todoEvent)).toBe(false);
    expect(shouldEnterAgentContext(subrunEvent)).toBe(false);
    expect(shouldEnterAgentContext(hiddenUserInput)).toBe(false);
    expect(shouldReplayRuntimeEventToUi(hiddenUserInput)).toBe(false);
    expect(shouldPersistRuntimeEvent(hiddenUserInput)).toBe(true);
  });

  it('final_answer_chunk 应只走实时 SSE，不应进入历史回放', () => {
    const chunkEvent = createBaseEvent({
      type: 'final_answer_chunk',
      id: 'chunk_1',
      answer_id: 'answer_1',
      seq: 0,
      content: 'partial',
      is_last: false,
      ephemeral: true,
    });

    expect(shouldEmitRuntimeEventToSse(chunkEvent)).toBe(true);
    expect(shouldReplayRuntimeEventToUi(chunkEvent)).toBe(false);
    expect(getRuntimeEventUiProjectionKind(chunkEvent)).toBe('final_answer_chunk');
  });

  it('checkpoint history_summary 应进入历史回放，但不走实时 SSE', () => {
    const checkpointSummary = createBaseEvent({
      type: 'history_summary',
      id: 'summary_1',
      content: 'checkpoint summary',
      original_message_count: 3,
      compression_ratio: 0.5,
      replaced_message_ids: ['msg_1', 'msg_2'],
      summary_seq: 1,
      metadata: {
        summary_kind: 'checkpoint',
      },
    });

    expect(shouldReplayRuntimeEventToUi(checkpointSummary)).toBe(true);
    expect(shouldEmitRuntimeEventToSse(checkpointSummary)).toBe(false);
    expect(getRuntimeEventUiProjectionKind(checkpointSummary)).toBe('checkpoint_history_summary');
  });

  it('audit_envelope 应只持久化，不进 UI / 上下文 / SSE', () => {
    const event = createBaseEvent({
      type: 'audit_envelope',
      id: 'audit_evt_1',
      envelope: {
        envelopeId: 'audit_1',
        runId: 'run_1',
        ts: 1,
        actor: { kind: 'system' },
        action: 'model.select',
        scope: {
          conversationId: 'conv_contract',
          runId: 'run_1',
          turnId: 'turn_contract',
        },
      },
    });

    expect(shouldPersistRuntimeEvent(event)).toBe(true);
    expect(shouldReplayRuntimeEventToUi(event)).toBe(false);
    expect(shouldEnterAgentContext(event)).toBe(false);
    expect(shouldEmitRuntimeEventToSse(event)).toBe(false);
    expect(getRuntimeEventUiProjectionKind(event)).toBe('audit_envelope');
  });
});
