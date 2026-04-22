import type { RuntimeEvent } from '../../../contracts';

export type PersistedEvent = {
  eventId: string;
  timestamp: number;
  conversationId: string;
  runId?: string;
  event: RuntimeEvent;
};

export type EventRangeOptions = {
  fromEventId?: string;
  toEventId?: string;
  limit?: number;
};

export interface EventStore {
  append(conversationId: string, event: PersistedEvent): Promise<void>;
  range(conversationId: string, opts?: EventRangeOptions): Promise<PersistedEvent[]>;
  latestEventId(conversationId: string): Promise<string | null>;
  truncate?(conversationId: string, opts: { beforeEventId?: string; beforeMs?: number }): Promise<void>;
}

export function createMonotonicEventIdFactory(
  nowProvider: () => number = () => Date.now(),
): () => string {
  let lastTimestamp = 0;
  let counter = 0;

  return () => {
    const timestamp = nowProvider();
    if (timestamp === lastTimestamp) {
      counter += 1;
    } else {
      lastTimestamp = timestamp;
      counter = 0;
    }

    return `${String(timestamp).padStart(13, '0')}-${String(counter).padStart(4, '0')}`;
  };
}
