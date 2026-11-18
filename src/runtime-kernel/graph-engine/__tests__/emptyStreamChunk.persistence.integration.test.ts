import { describe, expect, it } from 'vitest';
import { SSEFinalAnswerChunkEvent, runtimeEventToSSEEvent } from '../../../contracts';
import { createGraphScenario, type ScriptedLlmTurn } from '../../../testkit';

async function runStream(turns: ScriptedLlmTurn[], processStreamChunk: (chunk: string) => string) {
  const scenario = createGraphScenario({
    model: turns,
    contextBuilder: {
      async build() {
        return {
          llmMessages: [{ role: 'user' as const, content: 'Complete the answer' }],
          outputProcessor: { processStreamChunk },
        };
      },
    },
  });
  const run = await scenario.start('Complete the answer');
  if (run.status === 'failed') throw run.error;
  scenario.model.assertAllTurnsConsumed();
  return {
    live: scenario.live,
    calls: scenario.modelCalls(),
    checkpoint: await scenario.checkpoint(),
    stored: await scenario.history(),
  };
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
