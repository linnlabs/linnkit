import { describe, expect, it, vi } from 'vitest';
import {
  createToolCallDecisionEvent,
  RunIdSchema,
  ToolCallIdSchema,
  type RoutedRuntimeEvent,
} from '../../../contracts';
import { EventBus } from '../../execution/event-bus';
import { EventBusEventPersistence } from '../../execution/eventBusEventPersistence';
import { RuntimeEventPublisher } from '../../execution/runtimeEventPublisher';
import { EventSequencer } from '../../execution/sequencer';
import { MemoryCheckpointer } from '../checkpointer/memoryCheckpointer';
import { GraphExecutor } from '../engine';
import { createMonotonicEventStoreIdFactory } from '../event-store/base';
import { MemoryEventStore } from '../event-store/memoryEventStore';
import { parseEngineCheckpoint } from '../functions/parseEngineCheckpoint';
import { ToolNode } from '../nodes/toolNode';
import type { StandardToolCall } from '../types';

function fixture(batchSizes: readonly number[]) {
  const checkpointer = new MemoryCheckpointer();
  const eventStore = new MemoryEventStore();
  const nextEventStoreId = createMonotonicEventStoreIdFactory();
  const live: RoutedRuntimeEvent[] = [];
  const observedHistories: RoutedRuntimeEvent[][] = [];
  let decisionIndex = 0;
  let callIndex = 0;
  let rejectedCallId: string | undefined;
  const executeTool = vi.fn(async () => ({
    success: true,
    result: { data: {}, observation: 'owner executed' },
    durationMs: 1,
  }));

  function execution() {
    const sequencer = new EventSequencer('conversation');
    const eventBus = new EventBus(sequencer.getExecutionId());
    eventBus.on('event', envelope => live.push(envelope.payload));
    const publisher = new RuntimeEventPublisher(eventBus, sequencer, {
      run_id: RunIdSchema.parse('run'), lane: 'foreground', visibility: 'conversation',
    });
    const persistence = new EventBusEventPersistence({
      eventBus, eventStore, nextEventStoreId,
      async checkpointWriter({ checkpointKey, checkpoint, events }) {
        if (events.some(({ event }) => event.type === 'tool_output'
          && event.tool_call_id === rejectedCallId)) throw new Error('checkpoint storage unavailable');
        // Host 从 JSON 存储恢复时才 parse，显式经历相同的序列化边界。
        const stored: unknown = JSON.parse(JSON.stringify(checkpoint));
        const parsed = parseEngineCheckpoint(stored);
        await checkpointer.save(checkpointKey, parsed);
        for (const event of events) await eventStore.append(event);
      },
    });
    persistence.connect();
    const capabilities = {
      runtimeEventSink: (event: Parameters<typeof publisher.publish>[0], source: string) =>
        publisher.publish(event, source),
      toolContext: { conversationId: 'conversation', turnId: 'turn' },
    };
    const graph = new GraphExecutor(checkpointer, {
      maxSteps: 20,
      executionCheckpointPort: {
        commit: (key, state) => persistence.commitCheckpoint(key, state),
      },
    });
    graph.registerNode(new ToolNode({
      toolRuntime: {
        getToolDefinition: () => ({
          parameters: { type: 'object', properties: {} },
          validateArguments: () => ({ success: false, error: 'action must be an object with type' }),
        }),
        executeTool,
      },
      observationPreview: { async truncateObservation() { return { truncated: false }; } },
    }));
    graph.registerNode({
      id: 'llm',
      async run(state) {
        const history = state.local?.history ?? [];
        const size = batchSizes[decisionIndex++];
        if (size === undefined) {
          // 显式继续只能消费原提交历史，不能重新决策或重跑已拒绝的工具。
          const persisted = await eventStore.range('conversation');
          observedHistories.push(persisted.map(item => item.event));
          expect(history.map(event => event.id)).toEqual(persisted.map(item => item.event.id));
          return { kind: 'yield', events: [] };
        }
        const calls: StandardToolCall[] = Array.from({ length: size }, () => ({
          id: ToolCallIdSchema.parse(`call-${++callIndex}`),
          type: 'function',
          function: { name: 'process', arguments: '{"action":"wait","process_handle":"process-1"}' },
        }));
        const decision = publisher.publish(createToolCallDecisionEvent(
          `decision-${decisionIndex}`, 'conversation', 'turn', 'process', calls[0].id,
          { payload: { tool_calls: calls } },
        ), 'test.llm');
        state.local = { ...state.local, history: [...history, decision], pendingToolCalls: calls };
        return { kind: 'route', nextNodeId: 'tool', events: [decision] };
      },
    });
    return {
      graph, capabilities,
      async finish() {
        persistence.finishCheckpointWrites();
        try { await persistence.drain(); } finally { eventBus.close(); }
      },
      start: () => graph.startSession('run', {
        ...capabilities, conversationId: 'conversation', turnId: 'turn', history: [],
        request: { query: 'original', promptKey: 'agent' },
      }, 'llm'),
    };
  }
  async function checkpoint() {
    const state = await checkpointer.load('run');
    if (!state?.revision) throw new Error('missing checkpoint');
    return { state, revision: state.revision };
  }
  return {
    execution, checkpoint, executeTool, eventStore, live, observedHistories,
    rejectCall(id?: string) { rejectedCallId = id; },
  };
}

describe('protocol fuse with the checkpoint persistence consumer', () => {
  it.each([[1, 1, 1, 1], [6]])(
    '熔断前提交完整 batch；finishCheckpointWrites 不丢 terminal，显式继续不重跑',
    async (...batchSizes) => {
      const f = fixture(batchSizes);
      const execution = f.execution();
      await expect(execution.start()).rejects.toMatchObject({
        name: 'ToolProtocolFuseError', errorCode: 'tool.protocol_fuse',
      });
      await execution.finish();
      const count = batchSizes.reduce((total, size) => total + size, 0);
      const persisted = (await f.eventStore.range('conversation')).map(item => item.event);
      const outputs = persisted.filter(event => event.type === 'tool_output');
      expect(outputs.map(event => [event.tool_call_id, event.status])).toEqual(
        Array.from({ length: count }, (_, index) => [`call-${index + 1}`, 'error']),
      );
      expect(outputs.map(event => event.id)).toEqual(
        f.live.filter(event => event.type === 'tool_output').map(event => event.id),
      );
      expect(f.executeTool).not.toHaveBeenCalled();
      expect(f.observedHistories).toHaveLength(0);
      const checkpoint = await f.checkpoint();
      expect(checkpoint.state).toMatchObject({
        nodeId: 'llm', executionStatus: 'ready',
        local: { pendingToolCalls: [], _consecutiveToolProtocolErrors: count },
      });
      expect(checkpoint.state.local?.executingToolCallId).toBeUndefined();
      expect(checkpoint.state.local?.history?.map(event => event.id)).toEqual(persisted.map(event => event.id));

      const continued = f.execution();
      await continued.graph.continueSession('run', {
        expectedRevision: checkpoint.revision, capabilities: continued.capabilities,
      });
      await continued.finish();
      expect(f.observedHistories).toHaveLength(1);
      expect(await f.eventStore.range('conversation')).toHaveLength(persisted.length);
      expect(f.executeTool).not.toHaveBeenCalled();
    },
  );

  it('末次输出提交失败优先暴露存储错误；新 execution 仅重审未提交拒绝，不重复已提交结果', async () => {
    const f = fixture([1, 1, 1, 1]);
    f.rejectCall('call-4');
    const execution = f.execution();
    await expect(execution.start()).rejects.toThrow('checkpoint storage unavailable');
    await expect(execution.finish()).rejects.toThrow('checkpoint storage unavailable');
    expect((await f.eventStore.range('conversation')).filter(item => item.event.type === 'tool_output')).toHaveLength(3);
    const checkpoint = await f.checkpoint();
    expect(checkpoint.state.local?.pendingToolCalls?.map(call => call.id)).toEqual(['call-4']);
    expect(checkpoint.state.local?._consecutiveToolProtocolErrors).toBe(3);

    f.rejectCall();
    const continued = f.execution();
    await expect(continued.graph.continueSession('run', {
      expectedRevision: checkpoint.revision, capabilities: continued.capabilities,
    })).rejects.toMatchObject({ errorCode: 'tool.protocol_fuse' });
    await continued.finish();
    expect((await f.eventStore.range('conversation'))
      .filter(item => item.event.type === 'tool_output')
      .map(item => item.event.type === 'tool_output' && item.event.tool_call_id))
      .toEqual(['call-1', 'call-2', 'call-3', 'call-4']);
    expect(f.executeTool).not.toHaveBeenCalled();
  });
});
