import { describe, expect, it } from 'vitest';

import { createToolOutputEvent, routeRuntimeEvent } from '../../../../contracts';
import { resolveGraphStepResult } from '../graphStepResult';
import type { EngineState, NodeResult } from '../../types';

const routedToolOutput = routeRuntimeEvent(
  createToolOutputEvent(
    'tool_output_1',
    'conversation_1',
    'turn_1',
    'search',
    'tool_call_1',
    { status: 'success', observation: 'done', data: {} },
  ),
  {
    run_id: 'run_1',
    lane: 'foreground',
    visibility: 'conversation',
  },
);

function createState(state: Partial<EngineState> = {}): EngineState {
  return {
    nodeId: 'tool',
    local: {},
    ...state,
  };
}

describe('graphStepResult.resolveGraphStepResult', () => {
  it('route 结果切换到目标节点并透传事件', () => {
    const result = resolveGraphStepResult({
      state: createState({ nodeId: 'tool' }),
      result: {
        kind: 'route',
        nextNodeId: 'llm',
        events: [routedToolOutput],
      },
      checkpointCount: 0,
      maxCheckpoints: 2,
    });

    expect(result.state.nodeId).toBe('llm');
    expect(result.events).toEqual([routedToolOutput]);
    expect(result.action).toEqual({
      kind: 'route',
      fromNodeId: 'tool',
      nextNodeId: 'llm',
    });
    expect(result.checkpointReset).toEqual({ kind: 'none', checkpointCount: 0 });
    expect(result.shouldResetCycleStepBudget).toBe(false);
  });

  it('route 缺省 nextNodeId 时沿用 user 兜底语义', () => {
    const result = resolveGraphStepResult({
      state: createState({ nodeId: 'custom' }),
      result: { kind: 'route' },
      checkpointCount: 0,
      maxCheckpoints: 2,
    });

    expect(result.state.nodeId).toBe('user');
    expect(result.action).toEqual({
      kind: 'route',
      fromNodeId: 'custom',
      nextNodeId: 'user',
    });
  });

  it('yield 和 pause 保持当前节点并返回对应动作', () => {
    const yieldResult = resolveGraphStepResult({
      state: createState({ nodeId: 'wait' }),
      result: { kind: 'yield' },
      checkpointCount: 0,
      maxCheckpoints: 2,
    });
    const pauseResult = resolveGraphStepResult({
      state: createState({ nodeId: 'wait_user' }),
      result: { kind: 'pause' },
      checkpointCount: 0,
      maxCheckpoints: 2,
    });

    expect(yieldResult.state.nodeId).toBe('wait');
    expect(yieldResult.action).toEqual({ kind: 'yield' });
    expect(pauseResult.state.nodeId).toBe('wait_user');
    expect(pauseResult.action).toEqual({ kind: 'pause' });
  });

  it('消费 checkpoint step reset 信号并要求重置本轮步数预算', () => {
    const result = resolveGraphStepResult({
      state: createState({
        local: {
          _checkpointStepReset: true,
          retained: 'value',
        },
      }),
      result: { kind: 'route', nextNodeId: 'llm' },
      checkpointCount: 0,
      maxCheckpoints: 2,
    });

    expect(result.state.local).toEqual({ retained: 'value' });
    expect(result.checkpointReset).toEqual({ kind: 'applied', checkpointCount: 1 });
    expect(result.shouldResetCycleStepBudget).toBe(true);
  });

  it('checkpoint reset 超过上限时仍清理一次性信号但不重置步数预算', () => {
    const result = resolveGraphStepResult({
      state: createState({
        local: {
          _checkpointStepReset: true,
          retained: 'value',
        },
      }),
      result: { kind: 'yield' },
      checkpointCount: 2,
      maxCheckpoints: 2,
    });

    expect(result.state.local).toEqual({ retained: 'value' });
    expect(result.checkpointReset).toEqual({ kind: 'limit_exceeded', checkpointCount: 3 });
    expect(result.shouldResetCycleStepBudget).toBe(false);
  });
});
