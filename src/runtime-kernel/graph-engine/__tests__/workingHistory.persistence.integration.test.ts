import { describe, expect, it } from 'vitest';
import {
  createErrorEvent, createThoughtEvent, RuntimeEvent,
  SSEFinalAnswerChunkEvent, runtimeEventToSSEEvent,
} from '../../../contracts';
import type { ToolParameterSchema } from '../../../ports';
import { createGraphScenario } from '../../../testkit';
import { shouldPersistRuntimeEvent } from '../../events/eventGovernance';

const PAGE_PARAMETERS: ToolParameterSchema = {
  type: 'object', properties: { page: { type: 'number', description: 'Page number' } }, required: ['page'],
};

async function runWithStreamDensity(chunkCount: number) {
  // 内容恒定，只改变流式切片数量；后续模型请求和恢复事实不应因此增长或改变。
  const text = 'x'.repeat(1000);
  const chunks = chunkCount === 1 ? [text] : Array.from({ length: chunkCount }, () => 'x');
  const prior = [
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
  const executedPages: unknown[] = [];
  const scenario = createGraphScenario({
    model: [
      { thoughtDeltas: chunks, contentChunks: chunks, toolCalls: [
        { id: 'call-1', name: 'write', arguments: { page: 1 } },
        { id: 'call-2', name: 'write', arguments: { page: 2 } },
      ] },
      { thoughtDeltas: ['verified'], contentChunks: ['complete'] },
    ],
    tools: {
      write: {
        description: 'Write a page',
        parameters: PAGE_PARAMETERS,
        run: ({ args }) => {
          executedPages.push(args.page);
          if (executedPages.length === 1) scenario.pause();
          return { data: { saved: args.page }, observation: `saved ${String(args.page)}` };
        },
      },
    },
    history: [...prior, oldProgress],
    maxSteps: 10,
    tokenizer: { estimateText: () => 1, estimateMessage: () => 1 },
    observationPreview: { async truncateObservation() { return { truncated: false, preview: 'saved' }; } },
  });

  expect((await scenario.start('Write two pages')).status).toBe('paused');
  const paused = await scenario.checkpoint();
  expect(paused?.local?.pendingToolCalls?.map(call => call.id)).toEqual(['call-2']);
  expect(paused?.local?.executingToolCallIds).toBeUndefined();
  expect(paused?.local?.history?.every(shouldPersistRuntimeEvent)).toBe(true);
  expect(paused?.local?.history).toEqual(expect.arrayContaining(prior));
  expect(paused?.local?.history?.some(event => event.id === oldProgress.id)).toBe(false);

  expect((await scenario.continue()).status).toBe('yielded');
  await scenario.close();
  scenario.model.assertAllTurnsConsumed();
  const resumed = await scenario.checkpoint();
  const durable = (await scenario.history()).filter(event => event.id !== oldProgress.id);
  const history = resumed?.local?.history ?? [];
  const live = scenario.live;
  expect(executedPages).toEqual([1, 2]);
  expect(resumed?.executionStatus).toBe('yielded');
  expect(history.every(shouldPersistRuntimeEvent)).toBe(true);
  // 断点里的工作历史就是会话的持久历史，不夹带实时进度。
  expect(history).toEqual(durable);
  expect(durable.filter(event => event.type === 'tool_output').map(event => [event.tool_call_id, event.status]))
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
  return { historyCount: history.length, storedCount: durable.length, replay: scenario.modelCalls()[1]?.messages };
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
