import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolNode } from '../toolNode';
import type { EngineState } from '../../types';
import type { PendingUserInput, PendingUserInputPort } from '../../definitions/pendingUserInput';
import { RunPauseRequested } from '../../definitions/runContinuation';
import type { ObservationPreviewPort, ToolRuntimePort } from '../../../tools/ports';
import { createRuntimeEventAdmissionSink } from './runtimeEventAdmissionFixture';
import { ToolCallIdSchema, type RuntimeEvent } from '../../../../contracts';

function call(id: string, name: string) {
  return { id: ToolCallIdSchema.parse(id), type: 'function' as const, function: { name, arguments: '{}' } };
}

function createPort(initial: PendingUserInput[]) {
  let pending = [...initial];
  const claimed: string[][] = [];
  const port: PendingUserInputPort & { claimed: string[][] } = {
    claimed,
    claim: vi.fn(() => {
      const taken = pending;
      pending = [];
      claimed.push(taken.map(input => input.id));
      return taken;
    }),
    confirm: vi.fn(),
    release: vi.fn((ids: readonly string[]) => {
      pending = [...initial.filter(input => ids.includes(input.id)), ...pending];
    }),
  };
  return port;
}

function createState(input: {
  port?: PendingUserInputPort;
  calls?: ReturnType<typeof call>[];
  commit?: (state: EngineState) => Promise<void>;
  remainingSteps?: number;
  signal?: AbortSignal;
}): EngineState {
  return {
    nodeId: 'tool',
    local: {
      conversationId: 'conv_steer',
      turnId: 'turn_steer',
      runtimeEventSink: createRuntimeEventAdmissionSink('conv_steer', 'run_steer'),
      toolContext: {},
      pendingToolCalls: input.calls ?? [call('call_a', 'tool_a'), call('call_b', 'tool_b')],
      ...(input.port ? { pendingUserInputPort: input.port } : {}),
      ...(input.commit ? { commitExecutionBoundary: input.commit } : {}),
      ...(input.remainingSteps !== undefined
        ? { executorLocal: { remainingSteps: input.remainingSteps } }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  };
}

function historyTypes(state: EngineState): string[] {
  return (state.local?.history ?? []).map((event: RuntimeEvent) =>
    event.type === 'user_input' ? `user_input:${event.delivery ?? 'run_start'}` : event.type);
}

describe('ToolNode 运行中插话', () => {
  let node: ToolNode;

  beforeEach(() => {
    const toolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'> = {
      getToolDefinition: vi.fn().mockReturnValue({ parameters: { type: 'object', properties: {} } }),
      executeTool: vi.fn(async (name: string) => ({
        success: true,
        result: JSON.stringify({ data: { name }, observation: `${name} done` }),
        durationMs: 1,
      })),
    };
    const observationPreview: ObservationPreviewPort = {
      truncateObservation: vi.fn(async ({ text }) => ({ truncated: false, preview: text })),
    };
    node = new ToolNode({ toolRuntime, observationPreview });
  });

  it('整批工具结算后才送达，排在所有工具结果之后，并随边界提交后确认', async () => {
    const port = createPort([{ id: 'steer_1', content: '别改那个文件', timestamp: 10 }]);
    const committedHistories: string[][] = [];
    const state = createState({
      port,
      commit: async boundary => { committedHistories.push(historyTypes(boundary)); },
    });

    const result = await node.run(state);

    expect(result).toMatchObject({ kind: 'route', nextNodeId: 'llm' });
    expect(port.claim).toHaveBeenCalledTimes(1);
    expect(port.confirm).toHaveBeenCalledWith(['steer_1']);
    expect(port.release).not.toHaveBeenCalled();
    const types = historyTypes(state);
    expect(types.at(-1)).toBe('user_input:mid_run');
    expect(types.filter(type => type === 'tool_output')).toHaveLength(2);
    expect(types.lastIndexOf('tool_output')).toBeLessThan(types.indexOf('user_input:mid_run'));
    // 插话与最后一个工具结果在同一次边界提交里落盘。
    expect(committedHistories.at(-1)?.at(-1)).toBe('user_input:mid_run');
    const steer = (state.local?.history ?? []).find((event: RuntimeEvent) => event.type === 'user_input');
    expect(steer).toMatchObject({
      id: 'steer_1', content: '别改那个文件', delivery: 'mid_run', timestamp: 10, run_id: 'run_steer',
    });
    expect(result.events.some(event => event.id === 'steer_1')).toBe(true);
  });

  it('边界提交失败时放回待送达，不确认', async () => {
    const port = createPort([{ id: 'steer_2', content: '换个方向' }]);
    const state = createState({
      port,
      calls: [call('call_a', 'tool_a')],
      commit: async boundary => {
        if (historyTypes(boundary).includes('user_input:mid_run')) throw new Error('disk full');
      },
    });

    await expect(node.run(state)).rejects.toThrow('disk full');
    expect(port.release).toHaveBeenCalledWith(['steer_2']);
    expect(port.confirm).not.toHaveBeenCalled();
  });

  it('剩余步数不够再调用一次模型时不取用', async () => {
    const port = createPort([{ id: 'steer_3', content: '顺便查一下 X' }]);
    const state = createState({ port, remainingSteps: 0 });

    await node.run(state);

    expect(port.claim).not.toHaveBeenCalled();
    expect(historyTypes(state)).not.toContain('user_input:mid_run');
  });

  it('暂停信号到达后不取用', async () => {
    const port = createPort([{ id: 'steer_4', content: '停一下' }]);
    const controller = new AbortController();
    const state = createState({ port, calls: [call('call_a', 'tool_a')] });
    const executeTool = vi.fn(async () => {
      controller.abort(new RunPauseRequested());
      return { success: true, result: JSON.stringify({ data: {}, observation: 'ok' }), durationMs: 1 };
    });
    node = new ToolNode({
      toolRuntime: {
        getToolDefinition: vi.fn().mockReturnValue({ parameters: { type: 'object', properties: {} } }),
        executeTool,
      },
      observationPreview: { truncateObservation: vi.fn(async ({ text }) => ({ truncated: false, preview: text })) },
    });
    state.local = { ...state.local, signal: controller.signal };

    await node.run(state).catch(() => undefined);

    expect(port.claim).not.toHaveBeenCalled();
  });

  it('没有待送达输入或没装配端口时行为不变', async () => {
    const empty = createPort([]);
    const withEmpty = createState({ port: empty });
    await node.run(withEmpty);
    expect(empty.confirm).not.toHaveBeenCalled();
    expect(historyTypes(withEmpty)).not.toContain('user_input:mid_run');

    const without = createState({});
    await expect(node.run(without)).resolves.toMatchObject({ kind: 'route', nextNodeId: 'llm' });
  });
});
