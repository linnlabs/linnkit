import { describe, expect, it } from 'vitest';
import {
  createErrorEvent, createThoughtEvent, createUserInputEvent, RunIdSchema, RuntimeEvent,
  SSEFinalAnswerChunkEvent, runtimeEventToSSEEvent, type RoutedRuntimeEvent,
} from '../../../contracts';
import { convertEventsToAiMessages } from '../../../context-manager/profiles/agent/utils/eventConverter';
import { formatAgentLlmMessages } from '../../../context-manager/shared/MessageFormatter';
import { createScriptedInferenceHarness } from '../../../testkit';
import { EventBus } from '../../execution/event-bus';
import { EventBusEventPersistence } from '../../execution/eventBusEventPersistence';
import { RuntimeEventPublisher } from '../../execution/runtimeEventPublisher';
import { EventSequencer } from '../../execution/sequencer';
import { shouldPersistRuntimeEvent } from '../../events/eventGovernance';
import type { ToolRuntimePort } from '../../tools/ports';
import { GraphAgentExecutor } from '../executor';
import { GraphExecutor } from '../engine';
import { MemoryCheckpointer } from '../checkpointer/memoryCheckpointer';
import { createMonotonicEventStoreIdFactory } from '../event-store/base';
import { MemoryEventStore } from '../event-store/memoryEventStore';
import { parseEngineCheckpoint } from '../functions/parseEngineCheckpoint';
import { RunPauseRequested } from '../definitions/runContinuation';
import { LlmNode } from '../nodes/llmNode';
import { ToolNode } from '../nodes/toolNode';

async function runWithStreamDensity(chunkCount: number) {
  // 内容恒定，只改变流式切片数量；后续模型请求和恢复事实不应因此增长或改变。
  const text = 'x'.repeat(1000);
  const chunks = chunkCount === 1 ? [text] : Array.from({ length: chunkCount }, () => 'x');
  const ai = createScriptedInferenceHarness([
    { thoughtDeltas: chunks, contentChunks: chunks, toolCalls: [
      { id: 'call-1', name: 'write', argumentsJson: '{"page":1}' },
      { id: 'call-2', name: 'write', argumentsJson: '{"page":2}' },
    ] },
    { thoughtDeltas: ['verified'], contentChunks: ['complete'] },
  ]);
  const checkpointer = new MemoryCheckpointer();
  const eventStore = new MemoryEventStore();
  const live: RoutedRuntimeEvent[] = [];
  const sequencer = new EventSequencer('conversation');
  const eventBus = new EventBus(sequencer.getExecutionId());
  eventBus.on('event', envelope => live.push(envelope.payload));
  const publisher = new RuntimeEventPublisher(eventBus, sequencer, {
    run_id: RunIdSchema.parse('run'), lane: 'foreground', visibility: 'conversation',
  });
  const persistence = new EventBusEventPersistence({
    eventBus, eventStore, nextEventStoreId: createMonotonicEventStoreIdFactory(),
    async checkpointWriter({ checkpointKey, checkpoint, events }) {
      const serialized: unknown = JSON.parse(JSON.stringify(checkpoint));
      await checkpointer.save(checkpointKey, parseEngineCheckpoint(serialized));
      for (const event of events) await eventStore.append(event);
    },
  });
  persistence.connect();
  const controller = new AbortController();
  const executedPages: unknown[] = [];
  const toolRuntime: ToolRuntimePort = {
    getToolSchemas: () => [{ type: 'function', function: {
      name: 'write', description: 'Write a page',
      parameters: { type: 'object', properties: { page: { type: 'number' } }, required: ['page'] },
    } }],
    getToolDefinition: () => ({ parameters: {
      type: 'object', properties: { page: { type: 'number' } }, required: ['page'],
    } }),
    async executeTool(_name, args) {
      executedPages.push(args.page);
      if (executedPages.length === 1) controller.abort(new RunPauseRequested());
      return { success: true, result: { data: { saved: args.page }, observation: `saved ${args.page}` }, durationMs: 1 };
    },
  };
  const reasoner = new GraphAgentExecutor({
    llmCaller: ai.getLlmCaller(), toolRuntime,
    contextBuilder: { async build({ history }) {
      return { llmMessages: formatAgentLlmMessages(convertEventsToAiMessages(history)) };
    } },
    tokenizer: { estimateText: () => 1, estimateMessage: () => 1 },
  });
  function engine() {
    const graph = new GraphExecutor(checkpointer, {
      maxSteps: 10,
      executionCheckpointPort: { commit: (key, state) => persistence.commitCheckpoint(key, state) },
    });
    graph.registerNode(new LlmNode({ reasoner }));
    graph.registerNode(new ToolNode({ toolRuntime, observationPreview: {
      async truncateObservation() { return { truncated: false, preview: 'saved' }; },
    } }));
    return graph;
  }
  const capabilities = {
    toolContext: { conversationId: 'conversation', turnId: 'turn' },
    runtimeEventSink: publisher.publish.bind(publisher),
  };
  const prior = [
    createUserInputEvent('user', 'conversation', 'turn', 'Write two pages'),
    createErrorEvent('prior-error', 'conversation', 'turn', 'Earlier durable diagnostic'),
    createThoughtEvent('prior-thought', 'conversation', 'turn', 'Earlier complete thought'),
    RuntimeEvent.parse({ type: 'control', id: 'prior-control',
      conversation_id: 'conversation', turn_id: 'turn', timestamp: 1, version: 1, op: 'branch' }),
    RuntimeEvent.parse({ type: 'requires_user_interaction', id: 'prior-interaction',
      conversation_id: 'conversation', turn_id: 'turn', timestamp: 2, version: 1,
      run_id: 'run', interaction_id: 'interaction', tool_call_id: 'prior-call',
      checkpoint_revision: 1, resume_token: 'resume', interaction_status: 'pending' }),
  ];
  const oldProgress = createThoughtEvent('old-progress', 'conversation', 'turn', 'Earlier delta', {
    ephemeral: true, is_complete: false,
  });
  try {
    await expect(engine().startSession('run', {
      ...capabilities, signal: controller.signal,
      conversationId: 'conversation', turnId: 'turn', history: [...prior, oldProgress],
      request: { query: 'Write two pages', promptKey: 'agent', model_id: 'model', enableTools: true },
    }, 'llm')).rejects.toMatchObject({ name: 'AbortError' });
    const paused = await checkpointer.load('run');
    if (!paused?.revision) throw new Error('Missing paused checkpoint');
    expect(paused.local?.pendingToolCalls?.map(call => call.id)).toEqual(['call-2']);
    expect(paused.local?.executingToolCallId).toBeUndefined();
    expect(paused.local?.history?.every(shouldPersistRuntimeEvent)).toBe(true);
    expect(paused.local?.history).toEqual(expect.arrayContaining(prior));
    expect(paused.local?.history?.some(event => event.id === oldProgress.id)).toBe(false);

    const resumed = await engine().continueSession('run', {
      expectedRevision: paused.revision,
      capabilities: { ...capabilities, signal: new AbortController().signal },
    });
    persistence.finishCheckpointWrites();
    await persistence.drain();
    ai.assertAllTurnsConsumed();
    const stored = (await eventStore.range('conversation')).map(item => item.event);
    const history = resumed.checkpoint.local?.history ?? [];
    expect(executedPages).toEqual([1, 2]);
    expect(resumed.checkpoint.executionStatus).toBe('yielded');
    expect(history.every(shouldPersistRuntimeEvent)).toBe(true);
    expect(history.filter(event => !prior.some(old => old.id === event.id))).toEqual(stored);
    expect(stored.filter(event => event.type === 'tool_output').map(event => [event.tool_call_id, event.status]))
      .toEqual([['call-1', 'success'], ['call-2', 'success']]);
    expect(history.filter(event => event.type === 'thought')).toHaveLength(3);
    expect(live.filter(event => event.type === 'thought' && event.ephemeral)).toHaveLength(chunkCount + 1);
    expect(live.some(event => event.type === 'tool_process')).toBe(true);
    const liveChunks = live.filter(event => event.type === 'final_answer_chunk');
    expect(liveChunks.slice(0, chunkCount).map(event => event.seq))
      .toEqual(Array.from({ length: chunkCount }, (_, seq) => seq));
    expect(liveChunks.at(-1)?.seq).toBe(0);
    expect(liveChunks[0]?.answer_id).not.toBe(liveChunks.at(-1)?.answer_id);
    for (const chunk of liveChunks) {
      expect(SSEFinalAnswerChunkEvent.parse(runtimeEventToSSEEvent(chunk)).chunk).toBe(chunk.content);
    }
    expect(resumed.events.some(event => event.ephemeral === true)).toBe(true);
    return { historyCount: history.length, storedCount: stored.length, replay: ai.getCalls()[1]?.messages };
  } finally {
    eventBus.close();
  }
}

describe('working history is durable state, not the realtime stream journal', () => {
  it('高密度流式输出跨工具暂停/继续仍保留相同模型回放与终态，checkpoint 不随 chunks 膨胀', async () => {
    const sparse = await runWithStreamDensity(1);
    const dense = await runWithStreamDensity(1000);
    expect(dense).toEqual(sparse);
    expect(dense.replay).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'tool' }),
    ]));
  });
});
