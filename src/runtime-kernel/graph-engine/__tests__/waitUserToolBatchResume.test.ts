import { describe, expect, it, vi } from 'vitest';
import { GraphExecutor } from '../engine';
import { MemoryCheckpointer } from '../checkpointer/memoryCheckpointer';
import { ToolNode } from '../nodes/toolNode';
import { WaitUserNode } from '../nodes/waitUserNode';
import type { EngineState, NodeResult } from '../types';
import type { ObservationPreviewPort, ToolRuntimePort } from '../../tools/ports';
import { createRuntimeEventAdmissionSink } from '../nodes/__tests__/runtimeEventAdmissionFixture';
import {
  createToolOutputEvent,
  parseRuntimeEvents,
  ToolCallIdSchema,
  type RuntimeEvent,
} from '../../../contracts';

const CONVERSATION = 'conv-batch-ask';
const TURN = 'turn-batch-ask';
const RUN = 'run-batch-ask';
const ASK_CALL = 'call_00_ask';
const READ_CALL = 'call_01_read';

function toolCall(id: string, name: string) {
  return { id: ToolCallIdSchema.parse(id), type: 'function' as const, function: { name, arguments: '{}' } };
}

/** 真实 ToolNode / WaitUserNode 跑同一批 [ask, read]：ask 停在等待点，read 还没执行。 */
function createExecutor(seenByModel: string[][]) {
  const executeTool = vi.fn<ToolRuntimePort['executeTool']>(async name =>
    name === 'ask'
      ? {
          success: true,
          result: JSON.stringify({
            data: { questions: [{ id: 'q1' }] },
            observation: '等待用户回答问卷。',
            control: { requireUser: true },
          }),
        }
      : { success: true, result: JSON.stringify({ data: { ok: true }, observation: '读取完成。' }) },
  );
  const toolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'> = {
    getToolDefinition: vi.fn(() => ({ parameters: { type: 'object', properties: {} } })),
    executeTool,
  };
  const observationPreview: ObservationPreviewPort = {
    truncateObservation: vi.fn(async ({ text }) => ({ truncated: false, preview: text })),
  };
  const executor = new GraphExecutor(new MemoryCheckpointer(), { maxSteps: 10 });
  executor.registerNode(new ToolNode({ toolRuntime, observationPreview }));
  executor.registerNode(new WaitUserNode());
  executor.registerNode({
    id: 'llm',
    run: async (state: EngineState): Promise<NodeResult> => {
      const history = parseRuntimeEvents(state.local?.history ?? []);
      seenByModel.push(history.flatMap(event => (event.type === 'tool_output' ? [event.tool_call_id] : [])));
      return { kind: 'yield', events: [] };
    },
  });
  return { executor, executeTool };
}

function runtimeLocal() {
  return {
    conversationId: CONVERSATION,
    turnId: TURN,
    runtimeEventSink: createRuntimeEventAdmissionSink(CONVERSATION, RUN),
    toolContext: { runId: RUN },
  };
}

function answer(): RuntimeEvent {
  return createToolOutputEvent('evt-answer', CONVERSATION, TURN, 'ask', ASK_CALL, {
    status: 'success',
    observation: '{"answers":{"q1":"yes"}}',
    data: { answers: { q1: 'yes' } },
  });
}

async function pauseOnAsk(executor: GraphExecutor) {
  const paused = await executor.startSession(
    RUN,
    { ...runtimeLocal(), history: [], pendingToolCalls: [toolCall(ASK_CALL, 'ask'), toolCall(READ_CALL, 'read')] },
    'tool',
  );
  expect(paused.checkpoint.nodeId).toBe('wait_user');
  return paused.checkpoint;
}

describe('wait_user 恢复后先跑完同批剩下的工具调用', () => {
  it('同批 [ask, read]：回答写回后先执行 read，模型同时看到回答与 read 的结果', async () => {
    const seenByModel: string[][] = [];
    const { executor, executeTool } = createExecutor(seenByModel);
    const checkpoint = await pauseOnAsk(executor);
    expect(executeTool.mock.calls.map(([name]) => name)).toEqual(['ask']);

    const resumed = await executor.resumeSession(RUN, {
      expectedRevision: checkpoint.revision ?? 0,
      localPatch: { ...runtimeLocal(), history: [...(checkpoint.local?.history ?? []), answer()] },
    });

    expect(executeTool.mock.calls.map(([name]) => name)).toEqual(['ask', 'read']);
    expect(seenByModel).toEqual([[ASK_CALL, READ_CALL]]);
    expect(resumed.checkpoint.local?.pendingToolCalls ?? []).toEqual([]);
  });

  it('同批还有未执行调用时，不允许直接从 llm 恢复', async () => {
    const { executor } = createExecutor([]);
    const checkpoint = await pauseOnAsk(executor);

    await expect(
      executor.resumeSession(RUN, {
        expectedRevision: checkpoint.revision ?? 0,
        localPatch: { ...runtimeLocal(), history: [...(checkpoint.local?.history ?? []), answer()] },
        nodeId: 'llm',
      }),
    ).rejects.toThrow('pending tool call(s) from the interrupted batch');
  });
});
