import { describe, expect, it } from 'vitest';

import { createBuildDecisionStage } from './buildDecisionStage';
import { createTestTickPipelineContext } from '../__tests__/createTestTickPipelineContext';
import type { TickEvent } from '../types';

describe('buildDecisionStage provider replay sidecar', () => {
  it('工具调用决策事件应把 reasoning_details 绑定到 payload 标准位置', async () => {
    const reasoningDetails = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Need the tool.' },
    ];
    const emittedEvents: TickEvent[] = [];
    const ctx = createTestTickPipelineContext({
      context: {
        llmResp: {
          content: '我先读取文档。',
          reasoning_details: reasoningDetails,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'workspace_read', arguments: '{"path":"README.md"}' },
            },
          ],
        },
        eventHandler: (event) => emittedEvents.push(event),
      },
    });

    await createBuildDecisionStage({
      toolPresentation: {
        getDisplayOptions: () => ({ viewType: 'card' }),
      },
    }).run(ctx);

    const decision = emittedEvents.find((event) => event.type === 'tool_call_decision');
    expect(decision).toBeDefined();
    if (!decision || decision.type !== 'tool_call_decision') {
      throw new Error('expected tool_call_decision event');
    }
    expect(decision.payload?.reasoning_details).toEqual(reasoningDetails);
    expect(ctx.decision).toEqual({
      kind: 'tool_calls',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'workspace_read', arguments: '{"path":"README.md"}' },
        },
      ],
    });
  });

  it('最终回答事件应保留 LLM 响应中的 reasoning_details', async () => {
    const reasoningDetails = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Need a careful answer.' },
    ];
    const emittedEvents: TickEvent[] = [];
    const ctx = createTestTickPipelineContext({
      context: {
        input: { stream: false } as never,
        llmResp: {
          content: '最终回答。',
          reasoning_details: reasoningDetails,
        },
        eventHandler: (event) => emittedEvents.push(event),
      },
    });

    await createBuildDecisionStage({
      toolPresentation: {
        getDisplayOptions: () => ({ viewType: 'card' }),
      },
    }).run(ctx);

    const finalAnswer = emittedEvents.find((event) => event.type === 'final_answer');
    expect(finalAnswer).toBeDefined();
    if (!finalAnswer || finalAnswer.type !== 'final_answer') {
      throw new Error('expected final_answer event');
    }
    expect(finalAnswer.reasoning_details).toEqual(reasoningDetails);
    const persisted = ctx.newEvents.find((event) => event.type === 'final_answer');
    expect(persisted?.reasoning_details).toEqual(reasoningDetails);
  });
});
