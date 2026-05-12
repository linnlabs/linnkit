import { EventBus } from '../execution/event-bus';
import { EventSequencer } from '../execution/sequencer';
import { generateMessageId } from '../../shared/ids';
import type { SubRunTraceEnvelope, SubRunTracePublisher } from './subrunTrace.types';
import { Logger } from '../../shared/logger';
import { createSubRunTraceEvent } from '../../contracts';
import type { SubRunTraceEvent } from '../../contracts';

const logger = new Logger('SubRunTracePublisher');

export interface EventBusSubRunTracePublisherOptions {
  eventBus: EventBus;
  sequencer: EventSequencer;

  /** 父会话上下文：用于填充 RuntimeEvent 基础字段 */
  conversationId: string;
  turnId: string;

  /** 绑定关系：用于 UI 精确归属与并发分桶 */
  parentToolCallId: string;
  subrunId: string;
  subrunParentId?: string;

  /**
   * 事件来源（用于调试与过滤）
   * 建议格式：`subrun:<tool_name>` 或 `tool:<tool_name>:subrun`
   */
  source?: string;

  /**
   * 透传到 RuntimeEvent.metadata 的扩展字段（可选）
   * 注意：subrun_trace 默认不持久化，但 metadata 仍会随 SSE 推送给前端用于调试/归类。
   */
  metadata?: Record<string, unknown>;

  /**
   * 是否持久化 subrun_trace（用于历史回放）。
   *
   * 默认 false：
   * - subrun_trace 为高频增量过程事件，写入事实事件表会造成体积膨胀；
   * - 因此默认只走实时 SSE（ephemeral=true），不落库。
   *
   * 仅当业务明确需要“回放时可重建子过程”才应开启（例如 task 通用子 Agent）。
   *
   * ⚠️ 注意：
   * - 即使开启持久化，该事件仍属于 UI-only 数据；
   * - ContextManager 构建 LLM 上下文时必须过滤该类事件，避免污染父会话上下文。
   */
  persistForReplay?: boolean;
}

/**
 * EventBusSubRunTracePublisher
 *
 * 说明：
 * - 该发布器在构造时绑定 parent_tool_call_id 与 subrun_id；
 * - 每次 publish 只需要提供“分片载荷”（kind/delta/...）即可。
 */
export class EventBusSubRunTracePublisher implements SubRunTracePublisher {
  private readonly eventBus: EventBus;
  private readonly sequencer: EventSequencer;
  private readonly conversationId: string;
  private readonly turnId: string;
  private readonly parentToolCallId: string;
  private readonly subrunId: string;
  private readonly subrunParentId?: string;
  private readonly source: string;
  private readonly metadata?: Record<string, unknown>;
  private readonly persistForReplay: boolean;

  constructor(options: EventBusSubRunTracePublisherOptions) {
    this.eventBus = options.eventBus;
    this.sequencer = options.sequencer;
    this.conversationId = options.conversationId;
    this.turnId = options.turnId;
    this.parentToolCallId = options.parentToolCallId;
    this.subrunId = options.subrunId;
    this.subrunParentId = options.subrunParentId;
    this.source = options.source ?? 'subrun_trace';
    this.metadata = options.metadata;
    this.persistForReplay = options.persistForReplay === true;
  }

  publish(envelope: SubRunTraceEnvelope): void {
    // 🔥 关键：event.id 必须每条都唯一，否则前端 processedEvents 会丢弃重复事件
    const id = generateMessageId();

    const options: Partial<SubRunTraceEvent> = {
      // 默认 createSubRunTraceEvent 会设置 ephemeral=true；这里允许按需覆盖为 false 以支持回放
      ...(this.persistForReplay ? { ephemeral: false } : {}),
      // 绑定多级归属（如未来支持子 run 树）
      subrun_parent_id: this.subrunParentId,

      // 载荷透传
      delta: envelope.delta,
      content: envelope.content,
      tool_name: envelope.tool_name,
      tool_call_id: envelope.tool_call_id,
      phase: envelope.phase,
      status: envelope.status,
      args: envelope.args,
      output: envelope.output,
      duration_ms: envelope.duration_ms,
      meta: envelope.meta,

      // 可选 metadata 透传（用于前端调试/归类）
      metadata: this.metadata,
    };

    // createSubRunTraceEvent 内部默认设置 ephemeral=true（瞬时事件，不应持久化）
    const runtimeEvent = createSubRunTraceEvent(
      id,
      this.conversationId,
      this.turnId,
      this.parentToolCallId,
      this.subrunId,
      envelope.kind,
      options
    );

    const eventEnvelope = this.sequencer.wrapEvent(runtimeEvent, this.source);
    this.eventBus.publish(eventEnvelope);
  }
}
