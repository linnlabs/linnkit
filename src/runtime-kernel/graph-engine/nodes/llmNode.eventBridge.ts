/**
 * @file src/core/graph-engine/nodes/llmNode.eventBridge.ts
 *
 * @description
 * LlmNode 事件桥接对象 —— Phase 1.5-2b 的核心产物。
 *
 * 动机：
 * - Phase 1.5-2a 把状态变更收口为 reducer，但 SSE 分发、事件映射、
 *   stream_chunk 增强、final_answer 去重等副作用逻辑仍以闭包形式
 *   留在 LlmNode.run() 中，占据约一半的方法体。
 * - 本模块把这些"事件分发职责"抽为独立的 LlmNodeEventBridge 对象，
 *   使 LlmNode.run() 精简为：状态初始化 → 阶段/请求解析 → 创建 bridge
 *   → tick → 决策 dispatch → 状态回写 → 路由。
 *
 * 约束：
 * - bridge 不持有可变状态，所有状态读写通过 deps.getState / deps.dispatch 完成。
 * - bridge 不知晓 EngineState / NodeResult 等图执行概念，只负责单事件处理。
 * - 不依赖 features 层任何类型。
 */

import type { AnyAgentEvent } from '../../events/agentEvents';
import { generateMessageId } from '../../../shared/ids';
import { eventMapper } from '../../events/eventMappers';
import { Logger } from '../../../shared/logger';
import type { LlmNodeLocalState, LlmNodeAction } from './llmNode.state';
import type { RuntimeEvent } from '../../../contracts';

const logger = new Logger('LlmNode');

/** reasoner.tick 的事件类型（AnyAgentEvent 或 RuntimeEvent） */
export type TickEvent = AnyAgentEvent | RuntimeEvent;

/** 经 LlmNode 增强后下发 SSE 的 stream_chunk（补全 answer_id / seq / turn_id） */
type SseEnrichedStreamChunk = Extract<TickEvent, { type: 'stream_chunk' }> & {
  answer_id: string;
  seq: number;
  turn_id: string;
};

// ---------------------------------------------------------------------------
// 内部辅助函数（从 llmNode.ts 迁入）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 从 agentEvent 中读取有效的 answer_id。
 *
 * 中文备注：
 * - 过滤掉空字符串和占位符 'temp_answer'
 * - 返回 undefined 表示上游未指定有效 answer_id
 */
export function readIncomingAnswerId(agentEvent: unknown): string | undefined {
  if (!isRecord(agentEvent)) {
    return undefined;
  }
  const raw = agentEvent['answer_id'];
  if (typeof raw !== 'string') return undefined;

  const value = raw.trim();
  if (!value || value === 'temp_answer') {
    return undefined;
  }

  return value;
}

// ---------------------------------------------------------------------------
// 依赖接口
// ---------------------------------------------------------------------------

export interface LlmNodeEventBridgeDeps {
  /** 当前 reducer 状态的只读快照 */
  getState: () => LlmNodeLocalState;
  /** reducer 状态变更 dispatch */
  dispatch: (action: LlmNodeAction) => void;
  /**
   * SSE 下行出口（undefined 表示无前端连接）
   *
   * 中文备注：须与 graphLocal 的 GraphSseSink 一致（参数为 TickEvent，而非 unknown）；
   * 否则在 strictFunctionTypes 下窄参数函数不能赋给宽参数占位。
   */
  sseSink: ((evt: TickEvent) => RuntimeEvent[] | void) | undefined;
  /** 当前会话 ID */
  conversationId: string;
  /** 当前轮次 ID */
  turnId: string;
}

// ---------------------------------------------------------------------------
// LlmNodeEventBridge
// ---------------------------------------------------------------------------

/**
 * LlmNode 事件桥接对象：封装 SSE 分发、事件映射、stream_chunk 增强、final_answer 去重。
 *
 * 中文备注：
 * - 每次 LlmNode.run() 创建一个实例，生命周期与单次 run 相同。
 * - `handle` 方法可直接作为 reasoner.tick() 的 eventHandler 回调传递。
 * - 状态读写均通过 deps.getState / deps.dispatch 完成，bridge 本身无可变状态。
 */
export class LlmNodeEventBridge {
  private readonly deps: LlmNodeEventBridgeDeps;

  constructor(deps: LlmNodeEventBridgeDeps) {
    this.deps = deps;
  }

  /**
   * 处理 reasoner.tick 产生的单个事件。
   * 可直接作为 eventHandler 回调传递给 reasoner.tick()。
   */
  handle = (agentEvent: TickEvent): void => {
    if (!agentEvent || typeof agentEvent !== 'object') return;

    const { conversationId, turnId } = this.deps;
    const context = { conversationId, turnId, timestamp: agentEvent.timestamp ?? Date.now() };

    if (agentEvent.type === 'stream_chunk') {
      this.handleStreamChunk(agentEvent);
      return;
    }

    // 如果已经产生过流式 chunk，则忽略 LLM 直接返回的 final_answer
    // （StreamCollector 已负责收集 chunk 并生成最终的 final_answer）
    const state = this.deps.getState();
    if (agentEvent.type === 'final_answer' && state.chunkSeq > 0) {
      logger.info(`[LlmNode] 忽略 final_answer（已有 ${state.chunkSeq} 个 chunk）`);
      this.deps.dispatch({ type: 'FINAL_ANSWER_IGNORED' });
      return;
    }

    this.dispatchSse(agentEvent);

    const runtimeEvent = eventMapper.agentToRuntime(agentEvent, context, { skipIncomplete: true });
    if (runtimeEvent) {
      this.deps.dispatch({ type: 'RUNTIME_EVENT_BUFFERED', event: runtimeEvent });
    }

    if (agentEvent.type === 'final_answer') {
      this.deps.dispatch({ type: 'FINAL_ANSWER_RECEIVED' });
    }
  };

  // ── 私有方法 ──────────────────────────────────────────────────────────

  /**
   * 处理 stream_chunk 事件：
   * - 解析/生成 answer_id
   * - dispatch STREAM_CHUNK_RECEIVED
   * - 构建增强事件（补充 answer_id、seq、turn_id）
   * - 通过 SSE 发送增强事件
   */
  private handleStreamChunk(agentEvent: Extract<TickEvent, { type: 'stream_chunk' }>): void {
    const state = this.deps.getState();
    const incomingAnswerId = readIncomingAnswerId(agentEvent);
    const generatedAnswerId = state.answerId ?? generateMessageId();
    // 与 llmNodeReducer 的 STREAM_CHUNK_RECEIVED 解析规则一致，保证此处为 string
    const resolvedAnswerId = incomingAnswerId ?? generatedAnswerId;

    this.deps.dispatch({ type: 'STREAM_CHUNK_RECEIVED', incomingAnswerId, generatedAnswerId });

    const newState = this.deps.getState();
    const enrichedEvent: SseEnrichedStreamChunk = {
      ...agentEvent,
      answer_id: resolvedAnswerId,
      seq: newState.chunkSeq - 1,
      turn_id: this.deps.turnId,
    };

    this.dispatchSse(enrichedEvent);
  }

  /**
   * 将事件发送到 SSE 出口，并处理 sink 反馈的回灌事件。
   */
  private dispatchSse(evt: TickEvent): void {
    const { sseSink } = this.deps;
    if (!sseSink) {
      return;
    }
    try {
      this.markDispatched(evt);
      const returnedEvents = sseSink(evt);
      if (Array.isArray(returnedEvents) && returnedEvents.length > 0) {
        logger.info('[LlmNode] 收到 sink 回灌事件', {
          eventCount: returnedEvents.length,
        });
        for (const event of returnedEvents) {
          if (event) {
            this.deps.dispatch({ type: 'RUNTIME_EVENT_BUFFERED', event });
          }
        }
      }
    } catch (error: unknown) {
      const payload =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { detail: error };
      logger.error('SSE dispatch failed:', payload);
    }
  }

  /**
   * 标记事件已通过 SSE 分发（用于下游去重判断）。
   */
  private markDispatched(evt: TickEvent): void {
    if (isRecord(evt)) {
      Object.defineProperty(evt, '__dispatched_via_sse__', {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
}
