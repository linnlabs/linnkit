import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryCheckpointer } from '../memoryCheckpointer';
import type { CheckpointSummary } from '../base';
import type { EngineState } from '../../types';

function createEngineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    nodeId: 'llm',
    schemaVersion: 1,
    local: {},
    ...overrides,
  };
}

describe('MemoryCheckpointer contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists schemaVersion and exposes metadata without loading the full checkpoint', async () => {
    vi.setSystemTime(new Date('2026-04-22T09:30:00.000Z'));
    const checkpointer = new MemoryCheckpointer();

    await checkpointer.save(
      'conv-1',
      createEngineState({
        nodeId: 'answer',
        schemaVersion: 7,
        local: {
          pendingToolCalls: [
            {
              id: 'tool-1',
              type: 'function',
              function: {
                name: 'lookup',
                arguments: '{}',
              },
            },
          ],
          executorLocal: { stepCount: 3 },
        },
      }),
    );

    await expect(checkpointer.load('conv-1')).resolves.toMatchObject({
      nodeId: 'answer',
      schemaVersion: 7,
    });

    expect(checkpointer.peekMeta).toBeTypeOf('function');
    const peekMeta = checkpointer.peekMeta;
    if (!peekMeta) {
      throw new Error('MemoryCheckpointer.peekMeta must be implemented');
    }

    await expect(peekMeta.call(checkpointer, 'conv-1')).resolves.toEqual({
      conversationId: 'conv-1',
      schemaVersion: 7,
      savedAt: Date.parse('2026-04-22T09:30:00.000Z'),
      currentNode: 'answer',
      iterations: 3,
      hasPendingToolCalls: true,
    });
  });

  it('lists checkpoints with savedAfter and limit filters', async () => {
    const checkpointer = new MemoryCheckpointer();

    vi.setSystemTime(new Date('2026-04-22T09:00:00.000Z'));
    await checkpointer.save('conv-1', createEngineState({ nodeId: 'user', schemaVersion: 1 }));

    vi.setSystemTime(new Date('2026-04-22T10:00:00.000Z'));
    await checkpointer.save('conv-2', createEngineState({ nodeId: 'llm', schemaVersion: 2 }));

    vi.setSystemTime(new Date('2026-04-22T11:00:00.000Z'));
    await checkpointer.save('conv-3', createEngineState({ nodeId: 'answer', schemaVersion: 3 }));

    expect(checkpointer.list).toBeTypeOf('function');
    const list = checkpointer.list;
    if (!list) {
      throw new Error('MemoryCheckpointer.list must be implemented');
    }

    const summaries = await list.call(checkpointer, {
      savedAfter: Date.parse('2026-04-22T09:30:00.000Z'),
      limit: 2,
    });

    expect(summaries).toEqual<CheckpointSummary[]>([
      {
        conversationId: 'conv-3',
        schemaVersion: 3,
        savedAt: Date.parse('2026-04-22T11:00:00.000Z'),
        currentNode: 'answer',
        iterations: undefined,
        hasPendingToolCalls: false,
      },
      {
        conversationId: 'conv-2',
        schemaVersion: 2,
        savedAt: Date.parse('2026-04-22T10:00:00.000Z'),
        currentNode: 'llm',
        iterations: undefined,
        hasPendingToolCalls: false,
      },
    ]);
  });
});
