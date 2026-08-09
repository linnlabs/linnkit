import { describe, expect, it } from 'vitest';

import { sanitizeCheckpointLocal } from '../engineStateSnapshot';

describe('engineStateSnapshot.sanitizeCheckpointLocal', () => {
  it('剥离运行时引用，同时保留可恢复的执行状态', () => {
    const signal = new AbortController().signal;
    const local = {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      history: [{ id: 'event-1', nested: { content: 'before' } }],
      pendingToolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        },
      ],
      memory: { volatile: true },
      runtimeEventSink: () => undefined,
      signal,
      summarizationCallbacks: { onSummarizationStart: () => undefined },
      toolContext: { runId: 'run-1' },
    };

    const sanitized = sanitizeCheckpointLocal(local);

    expect(sanitized).toMatchObject({
      conversationId: 'conv-1',
      turnId: 'turn-1',
      history: [{ id: 'event-1', nested: { content: 'before' } }],
      pendingToolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        },
      ],
    });
    expect(sanitized).not.toHaveProperty('memory');
    expect(sanitized).not.toHaveProperty('runtimeEventSink');
    expect(sanitized).not.toHaveProperty('signal');
    expect(sanitized).not.toHaveProperty('summarizationCallbacks');
    expect(sanitized).not.toHaveProperty('toolContext');
  });

  it('返回深克隆快照，调用方修改结果不会污染原始 local', () => {
    const local = {
      history: [{ id: 'event-1', nested: { content: 'before' } }],
    };

    const sanitized = sanitizeCheckpointLocal(local);
    const history = sanitized.history;
    if (!Array.isArray(history)) {
      throw new Error('expected history array');
    }
    const firstEvent = history[0];
    if (!firstEvent || typeof firstEvent !== 'object' || Array.isArray(firstEvent)) {
      throw new Error('expected history event object');
    }
    const nested = firstEvent['nested'];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      throw new Error('expected nested object');
    }
    Object.assign(nested, { content: 'after' });

    expect(local.history[0].nested.content).toBe('before');
  });
});
