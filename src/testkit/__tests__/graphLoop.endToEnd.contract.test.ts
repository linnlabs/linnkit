import { describe, expect, it, vi } from 'vitest';

import { createGraphScenario } from '../index';

/**
 * linnkit 包内端到端回归门：真实 LlmNode / GraphAgentExecutor / ToolNode 与持久化边界，
 * 模型和工具用脚本代替。
 *
 * 中文备注：Host 侧可以用自己的默认装配另写集成测试；这里保证 testkit + runtime-kernel
 * 公开面在不依赖 Host 的前提下闭环，内核调度一旦回归会在这里第一时间失败。
 */
describe('graph loop end to end', () => {
  it('LLM → 工具 → LLM 终答', async () => {
    const scenario = createGraphScenario({
      model: [
        { toolCalls: [{ name: 'mock_tool', arguments: { query: 'hello' } }] },
        { contentChunks: ['工具结果已合成最终答案'] },
      ],
      tools: { mock_tool: ({ args }) => `observation for ${String(args.query)}` },
    });

    expect((await scenario.start('请执行端到端工具调用')).status).toBe('yielded');

    expect(scenario.tools.executions).toMatchObject([{ toolName: 'mock_tool', args: { query: 'hello' } }]);
    expect(await scenario.timeline()).toEqual([
      'user "请执行端到端工具调用"',
      'call mock_tool#call_1_1',
      'result mock_tool#call_1_1 success "observation for hello"',
      'answer "工具结果已合成最终答案"',
    ]);
    scenario.model.assertAllTurnsConsumed();
  });

  it('工具报错后回到模型继续推理并给出答案', async () => {
    const scenario = createGraphScenario({
      model: [
        { toolCalls: [{ name: 'mock_tool', arguments: { should_fail: true } }] },
        { contentChunks: ['工具失败后我也能给出兜底答案'] },
      ],
      tools: { mock_tool: () => ({ error: 'simulated execution failure' }) },
    });

    expect((await scenario.start('go')).status).toBe('yielded');

    expect((await scenario.timeline()).slice(2)).toEqual([
      'result mock_tool#call_1_1 error "simulated execution failure"',
      'answer "工具失败后我也能给出兜底答案"',
    ]);
    expect(scenario.modelCalls()).toHaveLength(2);
  });

  it('模型调用中取消：不执行已决定的工具，运行以取消结束', async () => {
    const executeTool = vi.fn(() => 'never');
    const scenario = createGraphScenario({
      model: [{
        toolCalls: [{ name: 'mock_tool' }],
        assertCall: () => { scenario.cancel(); },
      }],
      tools: { mock_tool: executeTool },
    });

    expect((await scenario.start('go')).status).toBe('cancelled');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('流式输出经过 outputProcessor，且保留处理器的方法上下文', async () => {
    const outputProcessor = {
      prefix: 'processed',
      processStreamChunk(chunk: string): string {
        return `${this.prefix}:${chunk}`;
      },
    };
    const scenario = createGraphScenario({
      model: [{ contentChunks: ['hello'] }],
      contextBuilder: {
        async build() {
          return { llmMessages: [{ role: 'user', content: 'hello' }], outputProcessor };
        },
      },
    });

    await scenario.start('hello graph loop');

    expect(scenario.live.filter(event => event.type.startsWith('final_answer'))).toEqual([
      expect.objectContaining({ type: 'final_answer_chunk', seq: 0, content: 'processed:hello' }),
      expect.objectContaining({ type: 'final_answer', content: 'processed:hello', is_complete: true }),
    ]);
  });

  it('工具调用后以 length 收口时不执行被截断的工具，半截输出不作为回答提交', async () => {
    const executeTool = vi.fn(() => 'never');
    const scenario = createGraphScenario({
      model: [{
        contentChunks: ['准备执行'],
        toolCalls: [{ name: 'mock_tool', arguments: { query: 'unfinished' } }],
        finishReason: 'length',
      }],
      tools: { mock_tool: executeTool },
    });

    const run = await scenario.start('执行工具');

    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ errorCode: 'llm.output_limit_reached', recoverable: false });
    expect(executeTool).not.toHaveBeenCalled();
    expect(scenario.live).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', error_code: 'llm.output_limit_reached', retryable: false }),
    ]));
    expect(scenario.live.some(event => event.type === 'tool_call_decision')).toBe(false);
    // 可恢复 Host：未提交的 attempt 作废，持久历史里只有用户输入（无恢复 Host 的中断回答见 llmNode.eventBridge 测试）。
    expect(await scenario.timeline()).toEqual(['user "执行工具"']);
  });
});
