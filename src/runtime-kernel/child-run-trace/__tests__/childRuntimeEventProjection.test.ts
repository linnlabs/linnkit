import { describe, expect, it } from 'vitest';

import {
  routeRuntimeEvent,
  runtimeEventToSSEEvent,
  validateRuntimeEvent,
  validateSSEEvent,
  type RoutedRuntimeEvent,
  type RuntimeEvent,
  ToolCallIdSchema,
} from '../../../contracts';
import { projectChildRuntimeEventToSubRunTrace } from '../projectChildRuntimeEventToSubRunTrace';
import { RuntimeEventSubRunTracePublisher } from '../runtimeEventSubRunTracePublisher';

const childIdentity = {
  run_id: 'child-run-1',
  parent_run_id: 'parent-run-1',
  lane: 'child' as const,
  visibility: 'parent-trace' as const,
};

function childEvent(event: RuntimeEvent): RoutedRuntimeEvent {
  return routeRuntimeEvent(event, childIdentity);
}

describe('child RuntimeEvent -> parent subrun trace', () => {
  it('把一次 decision 的完整工具批次保留为一个 durable parent trace fact', () => {
    const decision = childEvent({
      type: 'tool_call_decision',
      id: 'child-decision-1',
      conversation_id: 'conversation-1',
      turn_id: 'child-turn-1',
      timestamp: 1,
      version: 1,
      tool_name: 'read_file',
      tool_call_id: ToolCallIdSchema.parse('call-read'),
      phase: 'start',
      status: 'loading',
      payload: {
        tool_calls: [
          {
            id: 'call-read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"locator":"workspace:/a.md"}' },
          },
          {
            id: 'call-search',
            type: 'function',
            function: { name: 'grep', arguments: '{"locator":"workspace:/","pattern":"P0"}' },
          },
        ],
      },
    });

    expect(projectChildRuntimeEventToSubRunTrace(decision)).toEqual({
      kind: 'tool_call_decision',
      source_event_id: 'child-decision-1',
      tool_calls: [
        {
          tool_call_id: 'call-read',
          tool_name: 'read_file',
          args: { locator: 'workspace:/a.md' },
        },
        {
          tool_call_id: 'call-search',
          tool_name: 'grep',
          args: { locator: 'workspace:/', pattern: 'P0' },
        },
      ],
    });
  });

  it('多个答案段经同一纯投影保留 source identity、answer identity 与答案内序号', () => {
    const sourceEvents = [
      childEvent({
        type: 'final_answer_chunk',
        id: 'chunk-a-0',
        conversation_id: 'conversation-1',
        turn_id: 'child-turn-1',
        timestamp: 1,
        version: 1,
        answer_id: 'answer-a',
        seq: 0,
        content: '工具前说明',
      }),
      childEvent({
        type: 'final_answer',
        id: 'answer-a',
        conversation_id: 'conversation-1',
        turn_id: 'child-turn-1',
        timestamp: 2,
        version: 1,
        answer_id: 'answer-a',
        content: '工具前说明',
        completion_reason: 'tool_call',
        is_complete: true,
      }),
      childEvent({
        type: 'final_answer_chunk',
        id: 'chunk-b-0',
        conversation_id: 'conversation-1',
        turn_id: 'child-turn-1',
        timestamp: 3,
        version: 1,
        answer_id: 'answer-b',
        seq: 0,
        content: '最终交付',
        is_last: true,
      }),
      childEvent({
        type: 'final_answer',
        id: 'answer-b',
        conversation_id: 'conversation-1',
        turn_id: 'child-turn-1',
        timestamp: 4,
        version: 1,
        answer_id: 'answer-b',
        content: '最终交付',
        completion_reason: 'terminal',
        is_complete: true,
      }),
    ];

    expect(sourceEvents.map(projectChildRuntimeEventToSubRunTrace)).toEqual([
      {
        kind: 'final_answer_chunk',
        source_event_id: 'chunk-a-0',
        answer_id: 'answer-a',
        seq: 0,
        delta: '工具前说明',
      },
      {
        kind: 'final_answer',
        source_event_id: 'answer-a',
        answer_id: 'answer-a',
        content: '工具前说明',
        completion_reason: 'tool_call',
      },
      {
        kind: 'final_answer_chunk',
        source_event_id: 'chunk-b-0',
        answer_id: 'answer-b',
        seq: 0,
        delta: '最终交付',
        is_last: true,
      },
      {
        kind: 'final_answer',
        source_event_id: 'answer-b',
        answer_id: 'answer-b',
        content: '最终交付',
        completion_reason: 'terminal',
      },
    ]);
  });

  it('publisher 生成的 Runtime/SSE trace 共用正式 source 与答案字段', () => {
    const published: RuntimeEvent[] = [];
    const publisher = new RuntimeEventSubRunTracePublisher({
      runtimeEventSink: event => {
        published.push(event);
        return routeRuntimeEvent(event, {
          run_id: 'parent-run-1',
          lane: 'foreground',
          visibility: 'conversation',
        });
      },
      conversationId: 'conversation-1',
      turnId: 'parent-turn-1',
      parentToolCallId: ToolCallIdSchema.parse('parent-tool-call-1'),
      subrunId: 'child-run-1',
    });

    publisher.publish({
      kind: 'final_answer_chunk',
      source_event_id: 'child-chunk-0',
      answer_id: 'child-answer-1',
      seq: 0,
      delta: '交付',
      is_last: true,
    });
    publisher.publish({
      kind: 'final_answer',
      source_event_id: 'child-answer-1',
      answer_id: 'child-answer-1',
      content: '交付',
      completion_reason: 'terminal',
    });

    expect(published).toHaveLength(2);
    for (const event of published) {
      expect(validateRuntimeEvent(event).success).toBe(true);
      const sse = runtimeEventToSSEEvent(event);
      expect(validateSSEEvent(sse).success).toBe(true);
    }
    expect(published).toMatchObject([
      {
        type: 'subrun_trace',
        source_event_id: 'child-chunk-0',
        answer_id: 'child-answer-1',
        seq: 0,
        is_last: true,
      },
      {
        type: 'subrun_trace',
        source_event_id: 'child-answer-1',
        answer_id: 'child-answer-1',
      },
    ]);
  });

  it('不会把 child 执行指标投影成父工具卡内容', () => {
    const childMetrics = childEvent({
      type: 'run_execution_metrics',
      id: 'child-metrics-1',
      conversation_id: 'conversation-1',
      turn_id: 'child-turn-1',
      timestamp: 1,
      version: 1,
      execution_id: 'child-execution-1',
      outcome: 'completed',
      duration_ms: 10,
      user_message_id: 'child-user-1',
    });

    expect(projectChildRuntimeEventToSubRunTrace(childMetrics)).toBeNull();
  });

  it('共享协议拒绝缺 source identity 或答案归并字段的 trace', () => {
    const base = {
      type: 'subrun_trace',
      id: 'trace-1',
      conversation_id: 'conversation-1',
      turn_id: 'turn-1',
      timestamp: 1,
      version: 1,
      parent_tool_call_id: 'parent-call-1',
      subrun_id: 'child-run-1',
      kind: 'final_answer_chunk',
      delta: '正文',
    };

    expect(validateRuntimeEvent(base).success).toBe(false);
    expect(validateRuntimeEvent({ ...base, source_event_id: 'chunk-1' }).success).toBe(false);
    expect(
      validateSSEEvent({
        ...base,
        source_event_id: 'chunk-1',
        answer_id: 'answer-1',
      }).success
    ).toBe(false);
  });
});
