import type { EventEnvelope, RoutedRuntimeEvent, RuntimeEvent } from '../../contracts';
import type { EventStore } from '../graph-engine/event-store/base';
import { shouldPersistRuntimeEvent } from '../events/eventGovernance';
import type { EventBus } from './event-bus';

export interface EventBusEventPersistenceOptions {
  eventBus: EventBus;
  eventStore: EventStore;
  nextEventStoreId: () => string;
}

/**
 * EventBus durable consumer：按发布顺序串行写入事实，并在 run 进入终态前传播首个失败。
 * root、child 与 standalone runtime 共用这一实现，宿主不再各自维护 persistence queue。
 */
export class EventBusEventPersistence {
  private readonly scheduledEventIds = new Set<string>();
  private writeTail: Promise<void> = Promise.resolve();
  private firstWriteError: unknown;
  private connected = false;

  constructor(private readonly options: EventBusEventPersistenceOptions) {}

  connect(): void {
    if (this.connected) {
      throw new Error('[EventBusEventPersistence] consumer is already connected');
    }
    this.connected = true;
    this.options.eventBus.on('event', this.onEvent);
    this.options.eventBus.once('close', this.disconnect);
  }

  async drain(): Promise<void> {
    await this.writeTail;
    if (this.firstWriteError !== undefined) {
      throw this.firstWriteError;
    }
  }

  /** 已由 Host admission transaction 提交的 incoming fact 不得再次落盘。 */
  acknowledgePersisted(events: readonly RuntimeEvent[]): void {
    for (const event of events) {
      this.scheduledEventIds.add(event.id);
    }
  }

  private readonly onEvent = (envelope: EventEnvelope<RoutedRuntimeEvent>): void => {
    const event = envelope.payload;
    if (!shouldPersistRuntimeEvent(event) || this.scheduledEventIds.has(event.id)) {
      return;
    }

    this.scheduledEventIds.add(event.id);
    const eventStoreId = this.options.nextEventStoreId();
    const write = this.writeTail.then(async () => {
      await this.options.eventStore.append({ eventStoreId, event });
    });
    this.writeTail = write;
    void write.catch((error: unknown) => {
      this.firstWriteError ??= error;
    });
  };

  private readonly disconnect = (): void => {
    if (!this.connected) return;
    this.options.eventBus.off('event', this.onEvent);
    this.connected = false;
  };
}
