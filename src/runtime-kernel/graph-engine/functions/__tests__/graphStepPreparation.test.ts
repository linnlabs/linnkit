import { describe, expect, it } from 'vitest';

import { prepareGraphStep } from '../graphStepPreparation';
import type { EngineState } from '../../types';
import { ToolCallIdSchema } from '../../../../contracts';

function createState(state: Partial<EngineState> = {}): EngineState {
  return {
    nodeId: 'tool',
    local: {},
    ...state,
  };
}

describe('graphStepPreparation.prepareGraphStep', () => {
  it('普通步骤注入 executorLocal 步数信息并保持 running phase', () => {
    const result = prepareGraphStep({
      state: createState({
        local: {
          executorLocal: {
            stepCount: 0,
            phase: 'custom_phase',
          },
        },
      }),
      maxSteps: 5,
      cycleStepCount: 2,
      checkpointCount: 1,
    });

    expect(result.state.nodeId).toBe('tool');
    expect(result.executorLocal).toMatchObject({
      maxSteps: 5,
      stepCount: 2,
      remainingSteps: 3,
      checkpointCount: 1,
      phase: 'custom_phase',
    });
    expect(result.forcedToLlm).toBe(false);
  });

  it('final_answer 策略在最后一步清理 pending 状态并强制切到 llm', () => {
    const result = prepareGraphStep({
      state: createState({
        nodeId: 'tool',
        local: {
          pendingToolCalls: [
            {
              id: ToolCallIdSchema.parse('call-1'),
              type: 'function',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
          pendingInteractionSpec: { kind: 'ask' },
          lastToolResult: { ok: true },
        },
      }),
      maxSteps: 3,
      cycleStepCount: 3,
      checkpointCount: 0,
    });

    expect(result.state.nodeId).toBe('llm');
    expect(result.forcedToLlm).toBe(true);
    expect(result.forceReason).toBe('force final answer at maxSteps');
    expect(result.fromNodeId).toBe('tool');
    expect(result.state.local).toMatchObject({
      executorLocal: {
        phase: 'force_final_answer',
      },
    });
    expect(result.state.local?.pendingToolCalls).toBeUndefined();
    expect(result.state.local?.pendingInteractionSpec).toBeUndefined();
    expect(result.state.local?.lastToolResult).toBeUndefined();
  });

  it('force_tools 策略在倒数第二步强制切到 llm 并标记 force_tools phase', () => {
    const result = prepareGraphStep({
      state: createState({
        nodeId: 'tool',
        local: {
          executorLocal: {
            stepCount: 0,
            finalStepPolicy: 'force_tools',
          },
        },
      }),
      maxSteps: 4,
      cycleStepCount: 3,
      checkpointCount: 0,
    });

    expect(result.state.nodeId).toBe('llm');
    expect(result.executorLocal.phase).toBe('force_tools');
    expect(result.forceReason).toBe('force tools before maxSteps');
  });

  it('wait_user 和 answer 节点不被最后一步策略强制切换', () => {
    const waitUser = prepareGraphStep({
      state: createState({ nodeId: 'wait_user' }),
      maxSteps: 2,
      cycleStepCount: 2,
      checkpointCount: 0,
    });
    const answer = prepareGraphStep({
      state: createState({ nodeId: 'answer' }),
      maxSteps: 2,
      cycleStepCount: 2,
      checkpointCount: 0,
    });

    expect(waitUser.state.nodeId).toBe('wait_user');
    expect(waitUser.forcedToLlm).toBe(false);
    expect(answer.state.nodeId).toBe('answer');
    expect(answer.forcedToLlm).toBe(false);
  });

  it('进入 llm 节点时注入 LLM 调用语义并递增计数', () => {
    const first = prepareGraphStep({
      state: createState({ nodeId: 'llm' }),
      maxSteps: 4,
      cycleStepCount: 1,
      checkpointCount: 0,
    });
    const second = prepareGraphStep({
      state: createState({
        nodeId: 'llm',
        local: {
          executorLocal: {
            stepCount: 0,
            llmInvocationCount: 1,
          },
        },
      }),
      maxSteps: 4,
      cycleStepCount: 2,
      checkpointCount: 0,
    });

    expect(first.executorLocal).toMatchObject({
      llmInvocationKind: 'user_initiated',
      llmInvocationCount: 1,
    });
    expect(second.executorLocal).toMatchObject({
      llmInvocationKind: 'continuation',
      llmInvocationCount: 2,
    });
  });
});
