import type { EventRangeOptions, EventStore, PersistedEvent } from './base';

function clonePersistedEvent(event: PersistedEvent): PersistedEvent {
  return {
    ...event,
    event: { ...event.event },
  };
}

export class MemoryEventStore implements EventStore {
  private readonly store = new Map<string, PersistedEvent[]>();

  async append(conversationId: string, event: PersistedEvent): Promise<void> {
    const current = this.store.get(conversationId) ?? [];
    current.push(clonePersistedEvent(event));
    this.store.set(conversationId, current);
  }

  async range(conversationId: string, opts: EventRangeOptions = {}): Promise<PersistedEvent[]> {
    const events = [...(this.store.get(conversationId) ?? [])]
      .filter((event) => (opts.fromEventId ? event.eventId > opts.fromEventId : true))
      .filter((event) => (opts.toEventId ? event.eventId <= opts.toEventId : true));

    if (opts.limit === undefined) {
      return events.map(clonePersistedEvent);
    }

    return events.slice(0, opts.limit).map(clonePersistedEvent);
  }

  async latestEventId(conversationId: string): Promise<string | null> {
    const events = this.store.get(conversationId) ?? [];
    const latest = events.length > 0 ? events[events.length - 1] : undefined;
    return latest?.eventId ?? null;
  }

  async truncate(
    conversationId: string,
    opts: { beforeEventId?: string; beforeMs?: number },
  ): Promise<void> {
    const events = this.store.get(conversationId) ?? [];
    const retained = events.filter((event) => {
      if (opts.beforeEventId && event.eventId < opts.beforeEventId) {
        return false;
      }
      if (opts.beforeMs !== undefined && event.timestamp < opts.beforeMs) {
        return false;
      }
      return true;
    });
    this.store.set(conversationId, retained);
  }
}
