import { describe, expect, it } from 'vitest';
import { RunIdSchema, SSEFinalAnswerChunkEvent, runtimeEventToSSEEvent, type RoutedRuntimeEvent } from '../../../contracts';
import { createScriptedInferenceHarness, type ScriptedLlmTurn } from '../../../testkit';
import { EventBus } from '../../execution/event-bus';
import { EventBusEventPersistence } from '../../execution/eventBusEventPersistence';
import { RuntimeEventPublisher } from '../../execution/runtimeEventPublisher';
import { EventSequencer } from '../../execution/sequencer';
import type { ToolRuntimePort } from '../../tools/ports';
import { GraphAgentExecutor } from '../executor';
import { GraphExecutor } from '../engine';
import { MemoryCheckpointer } from '../checkpointer/memoryCheckpointer';
import { createMonotonicEventStoreIdFactory } from '../event-store/base';
import { MemoryEventStore } from '../event-store/memoryEventStore';
import { parseEngineCheckpoint } from '../functions/parseEngineCheckpoint';
import { LlmNode } from '../nodes/llmNode';

async function runStream(turns: ScriptedLlmTurn[], processStreamChunk: (chunk: string) => string) {
  const ai = createScriptedInferenceHarness(turns);
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
  const toolRuntime: ToolRuntimePort = {
    getToolSchemas: () => [],
    getToolDefinition: () => undefined,
    async executeTool() { throw new Error('Text stream must not execute tools'); },
  };
  const reasoner = new GraphAgentExecutor({
    llmCaller: ai.getLlmCaller(), toolRuntime,
    contextBuilder: {
      async build() {
        return {
          llmMessages: [{ role: 'user' as const, content: 'Complete the answer' }],
          outputProcessor: { processStreamChunk },
        };
      },
    },
  });
  const graph = new GraphExecutor(checkpointer, {
    executionCheckpointPort: { commit: (key, state) => persistence.commitCheckpoint(key, state) },
  });
  graph.registerNode(new LlmNode({ reasoner }));
  try {
    await graph.startSession('run', {
      conversationId: 'conversation', turnId: 'turn', history: [],
      request: { query: 'Complete the answer', promptKey: 'agent', model_id: 'model', enableTools: false },
      toolContext: { conversationId: 'conversation', turnId: 'turn' },
      runtimeEventSink: (event, source) => publisher.publish(event, source),
    }, 'llm');
    persistence.finishCheckpointWrites();
    await persistence.drain();
    ai.assertAllTurnsConsumed();
    return {
      live, calls: ai.getCalls(), checkpoint: await checkpointer.load('run'),
      stored: (await eventStore.range('conversation')).map(item => item.event),
    };
  } finally {
    eventBus.close();
  }
}

describe('filtered text chunks across the real LLM, Graph and persistence boundary', () => {
  it.each([
    { name: 'processor removes the first chunk', chunks: ['<hidden>', 'alpha', 'beta'] },
    { name: 'processor removes middle and trailing chunks but keeps whitespace', chunks: ['alpha', '<hidden>', ' ', 'beta', '<hidden>'] },
    { name: 'long stream with a late filtered chunk', chunks: [...Array.from({ length: 476 }, () => 'a'), '<hidden>', 'z'] },
  ])('$name retains every allocated sequence and one durable answer', async ({ chunks }) => {
    const expectedChunks = chunks.map(chunk => chunk === '<hidden>' ? '' : chunk);
    const result = await runStream([{ contentChunks: chunks }], chunk => chunk === '<hidden>' ? '' : chunk);
    const liveChunks = result.live.filter(event => event.type === 'final_answer_chunk');
    expect(liveChunks.map(event => [event.seq, event.content]))
      .toEqual(expectedChunks.map((content, seq) => [seq, content]));
    const wireChunks = liveChunks.map(event => SSEFinalAnswerChunkEvent.parse(runtimeEventToSSEEvent(event)));
    expect(wireChunks.map(event => [event.answer_id, event.seq, event.chunk]))
      .toEqual(expectedChunks.map((content, seq) => [liveChunks[0]?.answer_id, seq, content]));
    const answers = result.stored.filter(event => event.type === 'final_answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      answer_id: liveChunks[0]?.answer_id, content: expectedChunks.join(''), completion_reason: 'terminal',
    });
    expect(result.stored.some(event => event.type === 'final_answer_chunk' || event.type === 'error')).toBe(false);
    expect(result.checkpoint).toMatchObject({ nodeId: 'llm', executionStatus: 'yielded' });
    expect(result.checkpoint?.local?.history?.filter(event => event.type === 'final_answer')).toEqual(answers);
    expect(result.checkpoint?.local?.history?.some(event => event.type === 'final_answer_chunk')).toBe(false);
    expect(result.calls).toHaveLength(1);
  });

  it('empty chunks preserve retry reset identity and never contaminate the committed answer', async () => {
    const retryable = Object.assign(new Error('Retryable transport interruption'), {
      errorCode: 'llm.provider_down', recoverable: true, retryAfterMs: 0,
    });
    const result = await runStream([
      { contentChunks: ['<hidden>', 'partial', '<hidden>'], throwAfterEvents: retryable },
      { contentChunks: ['<hidden>', 'final', '<hidden>'] },
    ], chunk => chunk === '<hidden>' ? '' : chunk);
    const chunks = result.live.filter(event => event.type === 'final_answer_chunk');
    expect(chunks.map(event => event.seq)).toEqual([0, 1, 2, 0, 1, 2]);
    expect(chunks[0]?.answer_id).not.toBe(chunks[3]?.answer_id);
    const reset = result.live.filter(event => event.type === 'final_answer_reset');
    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatchObject({ answer_id: chunks[0]?.answer_id });
    const answers = result.stored.filter(event => event.type === 'final_answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ answer_id: chunks[3]?.answer_id, content: 'final' });
    expect(result.checkpoint?.local?.history?.some(event => event.type === 'final_answer_reset')).toBe(false);
    expect(result.calls).toHaveLength(2);
  });

  it('canonical empty deltas remain invalid before any runtime chunk is allocated', async () => {
    await expect(runStream([{ contentChunks: ['', 'answer'] }], chunk => chunk))
      .rejects.toThrow('[CanonicalInference] answer_delta 不能为空');
  });
});
