import {
  RunIdSchema,
  type RoutedRuntimeEvent,
  type RuntimeEventRoutingIdentity,
} from '../../contracts';
import { execution, type RuntimeEventSink } from '../../runtime-kernel';

export interface RuntimeEventRecorderOptions {
  conversationId?: string;
  runId?: string;
  /** 给出时按子运行身份发布（lane=child、visibility=parent-trace）。 */
  parentRunId?: string;
  lane?: RuntimeEventRoutingIdentity['lane'];
  visibility?: RuntimeEventRoutingIdentity['visibility'];
}

export interface RuntimeEventRecorder {
  /** Graph 节点使用的唯一发布出口（经过 admission，附着 run 身份与序号）。 */
  readonly sink: RuntimeEventSink;
  /** 按发布顺序收到的全部事件，包括只走实时通道的进度事件。 */
  readonly events: RoutedRuntimeEvent[];
  readonly eventBus: execution.EventBus;
  readonly sequencer: execution.EventSequencer;
  readonly publisher: execution.RuntimeEventPublisher;
  /** 同一会话、同一条总线上再开一个运行身份（例如多轮对话的下一次运行）。 */
  publisherFor(identity: RuntimeEventRoutingIdentity): execution.RuntimeEventPublisher;
  close(): void;
}

export function routingIdentityOf(options: RuntimeEventRecorderOptions): RuntimeEventRoutingIdentity {
  const child = options.parentRunId !== undefined;
  return {
    run_id: RunIdSchema.parse(options.runId ?? 'run'),
    ...(child ? { parent_run_id: RunIdSchema.parse(options.parentRunId) } : {}),
    lane: options.lane ?? (child ? 'child' : 'foreground'),
    visibility: options.visibility ?? (child ? 'parent-trace' : 'conversation'),
  };
}

/**
 * 测试用的 RuntimeEvent 发布出口：一条真实的 EventSequencer → EventBus → RuntimeEventPublisher 链，
 * 并把总线上的事件按顺序记下来。
 *
 * 取代各测试里手写的 sequencer / bus / publisher 三件套。
 */
export function createRuntimeEventRecorder(
  options: RuntimeEventRecorderOptions = {},
): RuntimeEventRecorder {
  const sequencer = new execution.EventSequencer(options.conversationId ?? 'conversation');
  const eventBus = new execution.EventBus(sequencer.getExecutionId());
  const events: RoutedRuntimeEvent[] = [];
  eventBus.on('event', envelope => events.push(envelope.payload));
  const publisher = new execution.RuntimeEventPublisher(eventBus, sequencer, routingIdentityOf(options));
  return {
    sink: (event, source) => publisher.publish(event, source),
    events,
    eventBus,
    sequencer,
    publisher,
    publisherFor: identity => new execution.RuntimeEventPublisher(eventBus, sequencer, identity),
    close: () => eventBus.close(),
  };
}
