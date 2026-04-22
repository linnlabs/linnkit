/**
 * @file src/agent/runtime-kernel/execution/event-bus.ts
 * @description 内存中的事件总线
 *
 * 功能 (What):
 * - 提供一个中央事件中心，用于发布和订阅 `EventEnvelope` 事件。
 * - 解耦事件的产生方（如 Runners）和消费方（如持久化、SSE推送）。
 * - 保证事件处理的逻辑集中化。
 *
 * 这是一个简单的、基于 EventEmitter 的实现，为每个执行流程（execution）创建一个实例。
 */

import { EventEmitter } from 'events';
import type { EventEnvelope } from '@app/schemas';
import { Logger } from '../../shared/logger';
import type { RuntimeEvent } from '../../contracts';

const logger = new Logger('EventBus');

// 定义事件总线可以发出的事件类型
type EventBusEvents = {
  'event': (envelope: EventEnvelope<RuntimeEvent>) => void;
  'error': (error: Error) => void;
  'close': () => void;
};

// 使用类型安全的 EventEmitter
// 使用组合模式，避免继承带来的类型冲突
class TypedEventEmitter<TEvents extends Record<string, any>> {
  private emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
  }

  on<TEvent extends keyof TEvents>(event: TEvent, listener: TEvents[TEvent]): this {
    this.emitter.on(event as string, listener as any);
    return this;
  }

  off<TEvent extends keyof TEvents>(event: TEvent, listener: TEvents[TEvent]): this {
    this.emitter.off(event as string, listener as any);
    return this;
  }

  once<TEvent extends keyof TEvents>(event: TEvent, listener: TEvents[TEvent]): this {
    this.emitter.once(event as string, listener as any);
    return this;
  }

  emit<TEvent extends keyof TEvents>(event: TEvent, ...args: Parameters<TEvents[TEvent]>): boolean {
    return this.emitter.emit(event as string, ...args);
  }

  removeAllListeners<TEvent extends keyof TEvents>(event?: TEvent): this {
    if (event) {
      this.emitter.removeAllListeners(event as string);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  setMaxListeners(n: number): this {
    this.emitter.setMaxListeners(n);
    return this;
  }
}

/**
 * 事件总线类
 *
 * 为每一次执行（execution）实例化一次，管理该执行生命周期内的所有事件。
 */
export class EventBus extends TypedEventEmitter<EventBusEvents> {
  public readonly executionId: string; // 🔥 改为 public 以便外部访问

  constructor(executionId: string) {
    super();
    this.executionId = executionId;
    this.setMaxListeners(30); // 默认10个，增加一些以防多工具监听等场景
    logger.info(`EventBus created for execution ${this.executionId}`);
  }

  /**
   * 发布一个事件到总线
   * @param envelope - 经过序列器包装的事件信封
   */
  publish(envelope: EventEnvelope<RuntimeEvent>): void {
    if (envelope.trace.execution_id !== this.executionId) {
      const error = new Error('EventEnvelope execution_id does not match EventBus instance.');
      logger.error('Mismatched execution_id', {
        busExecutionId: this.executionId,
        eventExecutionId: envelope.trace.execution_id,
        eventSeq: envelope.seq,
      });
      this.emit('error', error);
      return;
    }

    this.emit('event', envelope);
  }

  /**
   * 关闭总线，清理所有监听器
   */
  close(): void {
    logger.info(`Closing EventBus for execution ${this.executionId}`);
    this.emit('close');
    this.removeAllListeners();
  }
}
