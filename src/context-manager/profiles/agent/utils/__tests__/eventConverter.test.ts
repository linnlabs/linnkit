import { describe, expect, it } from 'vitest';
import { convertEventsToAiMessages } from '../eventConverter';
import type { RuntimeEvent } from '../../../../../contracts';
import { formatAgentLlmMessages } from '../../../../shared';

describe('agent/utils/eventConverter.convertEventsToAiMessages', () => {
  it('会过滤 tool_process，只保留 tool_call_decision 作为 tool_calls 锚点', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool_process',
        id: 'p_tool',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: Date.now(),
        version: 1,
        tool_name: 'context_checkpoint',
        tool_call_id: 'call_x',
        phase: 'start',
        status: 'loading',
        payload: { tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'context_checkpoint', arguments: '{}' } }] },
      } as RuntimeEvent,
      {
        type: 'tool_call_decision',
        id: 'd_llm',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: Date.now(),
        version: 1,
        tool_name: 'context_checkpoint',
        tool_call_id: 'call_x',
        phase: 'start',
        status: 'loading',
        payload: { tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'context_checkpoint', arguments: '{}' } }] },
        meta: { displayOptions: { viewType: 'card' } },
      } as RuntimeEvent,
      {
        type: 'tool_output',
        id: 'o1',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: Date.now(),
        version: 1,
        tool_name: 'context_checkpoint',
        tool_call_id: 'call_x',
        status: 'success',
        output: '{"ok":true}',
      } as RuntimeEvent,
    ];

    const messages = convertEventsToAiMessages(events);
    // 应仅保留一个 tool_calls（来自 LLM 的 tool_call_decision）+ tool_output
    const toolCalls = messages.filter((m) => m.type === 'tool_calls');
    const toolOutputs = messages.filter((m) => m.type === 'tool_output');

    expect(toolCalls).toHaveLength(1);
    expect(toolOutputs).toHaveLength(1);
    expect(toolCalls[0].id).toBe('d_llm');
  });

  it('会过滤空的 thought / final_answer，避免下一轮上下文出现空白 assistant 消息', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'user_input',
        id: 'u1',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: Date.now(),
        version: 1,
        content: '问题',
        source: 'user',
      } as RuntimeEvent,
      {
        type: 'thought',
        id: 'th_empty',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: Date.now(),
        version: 1,
        content: '   ',
        is_complete: true,
      } as RuntimeEvent,
      {
        type: 'final_answer',
        id: 'fa_empty',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: Date.now(),
        version: 1,
        answer_id: 'ans_empty',
        content: '',
        is_complete: false,
      } as RuntimeEvent,
      {
        type: 'final_answer',
        id: 'fa_ok',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: Date.now(),
        version: 1,
        answer_id: 'ans_ok',
        content: '有效回答',
        is_complete: true,
      } as RuntimeEvent,
    ];

    const messages = convertEventsToAiMessages(events);

    expect(messages.map((m) => m.id)).toEqual(['u1', 'fa_ok']);
    expect(messages.map((m) => m.content)).toEqual(['问题', '有效回答']);
  });

  it('交互工具提交后应保留合法的 tool_calls + tool_output 结构', () => {
    const events: RuntimeEvent[] = [
      {
        type: 'tool_call_decision',
        id: 'd1',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: 1,
        version: 1,
        tool_name: 'ppt_plan',
        tool_call_id: 'call_ppt_plan_1',
        phase: 'start',
        status: 'loading',
        payload: {
          tool_calls: [{ id: 'call_ppt_plan_1', type: 'function', function: { name: 'ppt_plan', arguments: '{}' } }],
        },
      } as RuntimeEvent,
      {
        type: 'tool_output',
        id: 'o_interaction',
        conversation_id: 'c1',
        turn_id: 't2',
        timestamp: 2,
        version: 1,
        tool_name: 'ppt_plan',
        tool_call_id: 'call_ppt_plan_1',
        status: 'success',
        output: '{"action":"approve"}',
        payload: {
          action: 'approve',
        },
        metadata: {
          interaction: {
            status: 'approved',
            response: { action: 'approve' },
          },
        },
      } as RuntimeEvent,
    ];

    const messages = convertEventsToAiMessages(events);
    expect(messages.map((message) => [message.id, message.role, message.type])).toEqual([
      ['d1', 'assistant', 'tool_calls'],
      ['o_interaction', 'tool', 'tool_output'],
    ]);
    expect(messages[1]?.content).toBe('{"action":"approve"}');
  });

  it('工具调用回放出关时应保留 provider replay sidecar', () => {
    const reasoningDetails = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Need the tool.' },
    ];
    const events: RuntimeEvent[] = [
      {
        type: 'tool_call_decision',
        id: 'd_sidecar',
        conversation_id: 'c1',
        turn_id: 't1',
        timestamp: 1,
        version: 1,
        tool_name: 'workspace_read',
        tool_call_id: 'call_sidecar_1',
        phase: 'start',
        status: 'loading',
        payload: {
          reasoning_details: reasoningDetails,
          tool_calls: [
            {
              id: 'call_sidecar_1',
              type: 'function',
              function: { name: 'workspace_read', arguments: '{"path":"README.md"}' },
              extra_content: {
                google: { thought_signature: '<sig>' },
                deepseek: { replay_marker: 'opaque' },
              },
            },
          ],
        },
      } as RuntimeEvent,
    ];

    const aiMessages = convertEventsToAiMessages(events);
    const llmMessages = formatAgentLlmMessages(aiMessages);
    const assistant = llmMessages.find((message) => message.role === 'assistant');

    expect(assistant).toBeDefined();
    if (!assistant || assistant.role !== 'assistant') {
      throw new Error('expected assistant tool_calls message');
    }
    expect(assistant.reasoning_details).toEqual(reasoningDetails);
    expect(assistant.tool_calls[0]).toEqual(
      expect.objectContaining({
        extra_content: expect.objectContaining({
          google: { thought_signature: '<sig>' },
          deepseek: { replay_marker: 'opaque' },
        }),
      }),
    );
  });
});
