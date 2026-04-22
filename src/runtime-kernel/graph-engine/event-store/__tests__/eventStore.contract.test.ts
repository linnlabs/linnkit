import { describe, expect, it } from 'vitest';

import { createMonotonicEventIdFactory } from '../base';
import { MemoryEventStore } from '../memoryEventStore';
import type { PersistedEvent } from '../base';
import type { RuntimeEvent } from '../../../../contracts';

function createRuntimeEvent(id: string, conversationId: string, timestamp: number): RuntimeEvent {
  return {
    type: 'user_input',
    id,
    conversation_id: conversationId,
    timestamp,
    turn_id: `turn-${id}`,
    version: 1,
    content: `content-${id}`,
    source: 'user',
  };
}

function createPersistedEvent(
  eventId: string,
  conversationId: string,
  timestamp: number,
): PersistedEvent {
  return {
    eventId,
    conversationId,
    timestamp,
    event: createRuntimeEvent(eventId, conversationId, timestamp),
  };
}

describe('EventStore contract', () => {
  it('creates monotonic event ids', () => {
    const nextEventId = createMonotonicEventIdFactory(() => 1_760_000_000_000);

    const first = nextEventId();
    const second = nextEventId();

    expect(first).not.toBe(second);
    expect(first < second).toBe(true);
  });

  it('appends and ranges events per conversation in append order', async () => {
    const store = new MemoryEventStore();

    await store.append('conv-1', createPersistedEvent('evt-1', 'conv-1', 10));
    await store.append('conv-1', createPersistedEvent('evt-2', 'conv-1', 20));
    await store.append('conv-2', createPersistedEvent('evt-3', 'conv-2', 30));

    await expect(store.range('conv-1')).resolves.toEqual([
      createPersistedEvent('evt-1', 'conv-1', 10),
      createPersistedEvent('evt-2', 'conv-1', 20),
    ]);
    await expect(store.latestEventId('conv-1')).resolves.toBe('evt-2');
  });

  it('truncates events before a cursor event id', async () => {
    const store = new MemoryEventStore();

    await store.append('conv-1', createPersistedEvent('evt-1', 'conv-1', 10));
    await store.append('conv-1', createPersistedEvent('evt-2', 'conv-1', 20));
    await store.append('conv-1', createPersistedEvent('evt-3', 'conv-1', 30));

    await store.truncate?.('conv-1', { beforeEventId: 'evt-3' });

    await expect(store.range('conv-1')).resolves.toEqual([
      createPersistedEvent('evt-3', 'conv-1', 30),
    ]);
  });
});
