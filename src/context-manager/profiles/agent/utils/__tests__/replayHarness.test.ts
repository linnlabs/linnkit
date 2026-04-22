import { describe, expect, it } from 'vitest';
import { createReplayHarness } from '../../../../../testkit/context-harness/replayHarness';
import type { RuntimeEvent } from '../../../../../contracts';

describe('ReplayHarness', () => {
  it('应过滤 tool_process，只保留 tool_call_decision 锚点与 tool_output', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'user_input',
        id: 'user_1',
        conversation_id: 'conv_1',
        turn_id: 'turn_1',
        timestamp: 1000,
        version: 1,
        content: '先调用搜索工具',
        source: 'user',
      } as RuntimeEvent,
      {
        type: 'tool_call_decision',
        id: 'decision_llm',
        conversation_id: 'conv_1',
        turn_id: 'turn_1',
        timestamp: 1100,
        version: 1,
        tool_name: 'web_search',
        tool_call_id: 'call_search_1',
        phase: 'start',
        status: 'loading',
        payload: {
          tool_calls: [
            {
              id: 'call_search_1',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: '{"query":"人工智能"}',
              },
            },
          ],
        },
      } as RuntimeEvent,
      {
        type: 'tool_process',
        id: 'process_tool',
        conversation_id: 'conv_1',
        turn_id: 'turn_1',
        timestamp: 1200,
        version: 1,
        tool_name: 'web_search',
        tool_call_id: 'call_search_1',
        phase: 'complete',
        status: 'success',
        payload: {
          tool_calls: [
            {
              id: 'call_search_1',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: '{"query":"人工智能"}',
              },
            },
          ],
        },
      } as RuntimeEvent,
      {
        type: 'tool_output',
        id: 'tool_output_1',
        conversation_id: 'conv_1',
        turn_id: 'turn_1',
        timestamp: 1300,
        version: 1,
        tool_name: 'web_search',
        tool_call_id: 'call_search_1',
        status: 'success',
        output: '{"observation":"搜索结果：人工智能"}',
      } as RuntimeEvent,
    ];

    const harness = createReplayHarness(events);
    const messages = harness.replay();

    expect(harness.getAssistantToolCallMessages()).toHaveLength(1);
    expect(harness.getToolOutputMessages()).toHaveLength(1);
    expect(messages.map((message) => message.id)).toEqual([
      'user_1',
      'decision_llm',
      'tool_output_1',
    ]);
  });
});
