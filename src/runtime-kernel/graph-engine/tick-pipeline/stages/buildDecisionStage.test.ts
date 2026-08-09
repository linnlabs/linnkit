import { describe, expect, it } from 'vitest';

import { createBuildDecisionStage } from './buildDecisionStage';
import { createTestTickPipelineContext } from '../__tests__/createTestTickPipelineContext';
import type { TickEvent } from '../types';
import { runTickPipeline } from '../runTickPipeline';

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

    await runTickPipeline(ctx, [createBuildDecisionStage()]);

    const decision = emittedEvents.find((event) => event.type === 'tool_call_decision');
    expect(decision).toBeDefined();
    if (!decision || decision.type !== 'tool_call_decision') {
      throw new Error('expected tool_call_decision event');
    }
    expect(decision.payload?.reasoning_details).toEqual(reasoningDetails);
    expect(decision.meta).not.toHaveProperty('displayOptions');
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
        llmResp: {
          content: '最终回答。',
          reasoning_details: reasoningDetails,
        },
        eventHandler: (event) => emittedEvents.push(event),
      },
    });

    await runTickPipeline(ctx, [createBuildDecisionStage()]);

    const finalAnswer = emittedEvents.find((event) => event.type === 'final_answer');
    expect(finalAnswer).toBeDefined();
    if (!finalAnswer || finalAnswer.type !== 'final_answer') {
      throw new Error('expected final_answer event');
    }
    expect(finalAnswer.reasoning_details).toEqual(reasoningDetails);
    expect(finalAnswer.answer_id).not.toBe('');
  });

  it('流式模式下无工具调用但有文本响应时应落成 final_answer 决策', async () => {
    const emittedEvents: TickEvent[] = [];
    const ctx = createTestTickPipelineContext({
      context: {
        llmResp: {
          content: '这是流式调用聚合后的最终回答。',
        },
        eventHandler: (event) => emittedEvents.push(event),
      },
    });

    await runTickPipeline(ctx, [createBuildDecisionStage()]);

    expect(ctx.decision).toEqual({
      kind: 'final_answer',
      answer: '这是流式调用聚合后的最终回答。',
    });
    const finalAnswer = emittedEvents.find((event) => event.type === 'final_answer');
    expect(finalAnswer).toMatchObject({
      type: 'final_answer',
      answer: '这是流式调用聚合后的最终回答。',
      answer_id: expect.any(String),
    });
  });

  it('整批工具调用必须都具备正式身份，不能只校验 primary', async () => {
    const ctx = createTestTickPipelineContext({
      context: {
        llmResp: {
          content: '',
          tool_calls: [
            {
              id: 'call_primary',
              type: 'function',
              function: { name: 'workspace_read', arguments: '{}' },
            },
            {
              id: '',
              type: 'function',
              function: { name: 'workspace_read', arguments: '{}' },
            },
          ],
        },
      },
    });

    await expect(runTickPipeline(ctx, [createBuildDecisionStage()])).rejects.toThrow('tool_calls[1].id');
    expect(ctx.decision).toBeUndefined();
  });
});
