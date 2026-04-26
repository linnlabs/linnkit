/**
 * @file src/agent/runtime-kernel/events/eventMappers.ts
 * @brief 统一事件映射器 - 解决重复的 switch...case 事件转换逻辑
 * 
 * @description
 * 本模块的职责是集中处理三种事件模型之间的转换：
 * 1. AnyAgentEvent (领域事件) → SSEEvent (表现层事件)
 * 2. AnyAgentEvent (领域事件) → RuntimeEvent (持久化事件)
 * 3. RuntimeEvent (持久化事件) → ConversationMemoryPort (内存重建)
 * 
 * 设计原则：
 * - 单一职责：只负责事件转换，不包含业务逻辑
 * - DRY：所有转换逻辑集中在此，消除重复代码
 * - 可测试：纯函数设计，易于单元测试
 * - 类型安全：充分利用TypeScript类型系统
 */

import {
  AnyAgentEvent,
  ThoughtEvent as AgentThoughtEvent,
  ToolCallDecisionEvent as AgentToolCallDecisionEvent,
  ToolProcessEvent as AgentToolProcessEvent,
  ObservationEvent as AgentObservationEvent,
  FinalAnswerEvent as AgentFinalAnswerEvent,
  StreamChunkEvent as AgentStreamChunkEvent,
  ErrorEvent as AgentErrorEvent,
  readAgentEventAnswerId,
  readAgentEventSeq,
  isMarkedAsSseDispatched,
} from './agentEvents';

import {
  createSSEThoughtEvent,
  createSSEToolCallDecisionEvent,
  createSSEToolProcessEvent,
  createSSEToolOutputEvent,
  createSSEFinalAnswerChunkEvent,
  createSSEFinalAnswerEvent,
  createSSEErrorEvent,
  type SSEEvent,
} from '../../contracts';

import { generateMessageId } from '../../shared/ids';
import type { ToolPresentationPort } from '../tools/ports';
import type { RuntimeEvent, ThoughtEvent as RuntimeThoughtEvent, ToolCallDecisionEvent as RuntimeToolCallDecisionEvent, ToolOutputEvent as RuntimeToolOutputEvent, FinalAnswerEvent as RuntimeFinalAnswerEvent, ErrorEvent as RuntimeErrorEvent, UserInputEvent as RuntimeUserInputEvent, AiMessage, ToolCallWire } from '../../contracts';
import { createThoughtEvent, createToolCallDecisionEvent, createToolProcessEvent, createToolOutputEvent, createFinalAnswerEvent, createFinalAnswerChunkEvent, createErrorEvent } from '../../contracts';

/**
 * 轻量类型守卫：避免在转换层引入 any 断言。
 */
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const isToolCallWire = (value: unknown): value is ToolCallWire => {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (value.type !== 'function') return false;
  const fn = value.function;
  return isRecord(fn) && typeof fn.name === 'string' && typeof fn.arguments === 'string';
};

// ================================================================
// 🎯 上下文类型定义
// ================================================================

export interface EventMappingContext {
  conversationId: string;
  turnId: string;
  timestamp?: number;
  /**
   * 事件级扩展元数据（透传到 SSE/RuntimeEvent.metadata）
   *
   * 典型用法：
   * - 方案B任务归属：`{ task: { runId, feature, stepIndex } }`
   *
   * 注意：这里不放 ui.hidden，避免误把“隐藏 user_input”扩散到 thought/action 等过程消息。
   */
  metadata?: Record<string, unknown>;
}

export interface SSEMappingOptions {
  emitSse?: boolean;
  skipAlreadyDispatched?: boolean;
  toolPresentationPort?: ToolPresentationPort;
}

export interface RuntimeMappingOptions {
  collectRuntime?: boolean;
  skipIncomplete?: boolean;
  toolPresentationPort?: ToolPresentationPort;
}

function resolveToolDisplayOptions(
  toolName: string,
  toolPresentationPort?: ToolPresentationPort,
) {
  return toolPresentationPort?.getDisplayOptions(toolName);
}

/**
 * RuntimeEvent 回放所需的最小会话内存端口。
 *
 * 中文备注：
 * - core 只依赖“写入消息”的最小能力，不再直接依赖 features 的 `ConversationSession`；
 * - 具体产品实现只要结构兼容即可接入。
 */
export interface ConversationMemoryPort {
  addUserMessage(content: string, id?: string): void;
  addAssistantMessage(
    content: string | null,
    type: AiMessage['type'] & ('thought' | 'final_answer' | 'tool_calls'),
    metadata?: AiMessage['metadata'],
    id?: string
  ): void;
  addToolResponse(toolCallId: string, content: string, toolName?: string, id?: string): void;
  appendMessage(message: AiMessage): void;
}

// ================================================================
// 🔄 AnyAgentEvent → SSEEvent 转换器
// ================================================================

/**
 * 将AgentEvent转换为SSEEvent
 * @param agentEvent 来自AgentExecutor的领域事件
 * @param context 转换上下文（会话ID、轮次ID等）
 * @param options 转换选项
 * @returns SSEEvent实例或null
 */
export function agentEventToSSE(
  agentEvent: AnyAgentEvent,
  context: EventMappingContext,
  options: SSEMappingOptions = {}
): SSEEvent | null {
  if (!agentEvent || typeof agentEvent !== 'object') {
    return null;
  }

  // 检查是否已经通过SSE分发，避免重复
  if (options.skipAlreadyDispatched && isMarkedAsSseDispatched(agentEvent)) {
    return null;
  }

  const { conversationId, turnId } = context;
  const timestamp = agentEvent.timestamp ?? context.timestamp ?? Date.now();
  const id = agentEvent.id ?? generateMessageId();
  const contextMeta = context.metadata;

  switch (agentEvent.type) {
    case 'thought': {
      const thoughtEvent = agentEvent as AgentThoughtEvent;
      const rawContent = 'content' in thoughtEvent ? thoughtEvent.content : '';
      const delta = 'delta' in thoughtEvent ? thoughtEvent.delta : '';
      const isComplete = 'is_complete' in thoughtEvent ? Boolean(thoughtEvent.is_complete) : false;
      const thoughtMessageId =
        typeof thoughtEvent.thought_message_id === 'string' && thoughtEvent.thought_message_id.length > 0
          ? thoughtEvent.thought_message_id
          : undefined;
      
      const sse = createSSEThoughtEvent(id, conversationId, turnId, {
        thought_message_id: thoughtMessageId,
        content: isComplete ? (rawContent ?? '') : undefined,
        delta: !isComplete ? (delta ?? rawContent) : undefined,
        is_complete: isComplete
      });
      sse.timestamp = timestamp;
      /**
       * 说明：
       * - context.metadata：跨事件的“归类信息”（如 task 分组）
       * - thoughtEvent.meta：该事件自身的补充信息（如 thought_started_at / thought_completed_at）
       * 合并后透传给前端，确保前端能用后端锚点精确计时。
       */
      const thoughtMeta = isRecord(thoughtEvent.meta) ? thoughtEvent.meta : undefined;
      if (contextMeta || thoughtMeta) {
        sse.metadata = { ...(contextMeta ?? {}), ...(thoughtMeta ?? {}) };
      }
      return sse;
    }

    case 'tool_call_decision':
    case 'tool_process': {
      const toolEvent =
        agentEvent.type === 'tool_call_decision'
          ? (agentEvent as AgentToolCallDecisionEvent)
          : (agentEvent as AgentToolProcessEvent);
      const toolName = toolEvent.tool_name || 'unknown_tool';
      const toolCallId = toolEvent.tool_call_id || `call_${id}`;
      const phase = toolEvent.phase ?? 'start';
      const status = toolEvent.status ?? 'loading';
      const args = toolEvent.tool_args || {};
      const payload = toolEvent.payload || {};
      
      const meta = toolEvent.meta && typeof toolEvent.meta === 'object' 
        ? { ...toolEvent.meta } 
        : {};
      const displayOptions = resolveToolDisplayOptions(toolName, options.toolPresentationPort);
      if (displayOptions && !meta.displayOptions) {
        meta.displayOptions = displayOptions;
      }

      const sse =
        agentEvent.type === 'tool_call_decision'
          ? createSSEToolCallDecisionEvent(id, conversationId, turnId, toolName, toolCallId, phase, status, {
              timestamp,
              args,
              payload,
              meta,
            })
          : createSSEToolProcessEvent(id, conversationId, turnId, toolName, toolCallId, phase, status, {
              timestamp,
              args,
              payload,
              meta,
            });
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    case 'observation': {
      const observationEvent = agentEvent as AgentObservationEvent;
      const toolName = observationEvent.tool_name || 'unknown_tool';
      const toolCallId = observationEvent.tool_call_id || `call_${id}`;
      const success = observationEvent.success;
      const status: 'success' | 'error' = success === false ? 'error' : 'success';
      const output = observationEvent.output;
      const payload = observationEvent.payload || {};
      const duration = payload.duration_ms as number | undefined;

      const sse = createSSEToolOutputEvent(
        id,
        conversationId,
        turnId,
        toolName,
        toolCallId,
        status,
        output,
        {
          timestamp,
          payload,
          duration_ms: duration
        }
      );
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    case 'stream_chunk': {
      const streamEvent = agentEvent as AgentStreamChunkEvent;
      const text = streamEvent.content ?? '';
      if (!text) {
        return null;
      }
      
      // 生成临时的answerId和seq，实际使用时可能需要从外部传入
      const answerId = readAgentEventAnswerId(streamEvent) ?? `answer_${turnId}`;
      const seq = readAgentEventSeq(streamEvent) ?? 0;
      const isLast = Boolean(
        ('isLast' in streamEvent && streamEvent.isLast) || 
        ('is_last' in streamEvent && streamEvent.is_last)
      );
      
      const sse = createSSEFinalAnswerChunkEvent(
        id,
        conversationId,
        turnId,
        answerId,
        seq,
        text,
        { is_last: isLast }
      );
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    case 'final_answer': {
      const finalAnswerEvent = agentEvent as AgentFinalAnswerEvent;
      const answer = finalAnswerEvent.answer ?? '';
      const answerIdFromSnake =
        typeof finalAnswerEvent.answer_id === 'string' && finalAnswerEvent.answer_id.trim().length > 0
          ? finalAnswerEvent.answer_id.trim()
          : undefined;
      const answerIdFromCamel = (() => {
        if (!isRecord(finalAnswerEvent)) return undefined;
        const v = finalAnswerEvent['answerId'];
        return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
      })();
      const answerId = answerIdFromSnake ?? answerIdFromCamel ?? `answer_${turnId}`;
      const meta = (() => {
        if (!isRecord(finalAnswerEvent)) return undefined;
        const v = finalAnswerEvent['meta'];
        return isRecord(v) ? (v as Record<string, unknown>) : undefined;
      })();
      
      const sse = createSSEFinalAnswerEvent(
        id,
        conversationId,
        turnId,
        answerId,
        answer,
        { meta }
      );
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    case 'error': {
      const errorEvent = agentEvent as AgentErrorEvent;
      const errorMessage = errorEvent.error ?? 'Unknown error';
      const details = errorEvent.details;
      
      const sse = createSSEErrorEvent(id, conversationId, turnId, errorMessage, {
        details
      });
      sse.timestamp = timestamp;
      if (contextMeta) sse.metadata = contextMeta;
      return sse;
    }

    default:
      return null;
  }
}

// ================================================================
// 🔄 AnyAgentEvent → RuntimeEvent 转换器  
// ================================================================

/**
 * 将AgentEvent转换为RuntimeEvent
 * @param agentEvent 来自AgentExecutor的领域事件
 * @param context 转换上下文
 * @param options 转换选项
 * @returns RuntimeEvent实例或null
 */
export function agentEventToRuntime(
  agentEvent: AnyAgentEvent | RuntimeEvent,
  context: EventMappingContext,
  options: RuntimeMappingOptions = {}
): RuntimeEvent | null {
  if (!agentEvent || typeof agentEvent !== 'object') {
    return null;
  }

  /**
   * ✅ 兼容透传：history_summary 作为 RuntimeEvent 借道统一管道发布
   *
   * 说明：
   * - history_summary 并不是 AnyAgentEvent 的一部分；
   * - 但 GraphAgentExecutor/Orchestrator 可能会把它作为“已构造好的 RuntimeEvent”交给统一事件管道发布；
   * - 这里显式识别并透传，避免在 switch(AnyAgentEvent.type) 中出现非法 case 导致类型错误。
   */
  const rawType = ((): unknown => {
    if (!isRecord(agentEvent)) return undefined;
    return agentEvent['type'];
  })();
  if (rawType === 'history_summary') {
    const evt = agentEvent as RuntimeEvent;
    const contextMeta = context.metadata;
    if (contextMeta) {
      evt.metadata = { ...(evt.metadata ?? {}), ...contextMeta };
    }
    return evt;
  }

  const { conversationId, turnId } = context;
  // 到这里可以确定是 AnyAgentEvent（非 history_summary）
  const typed = agentEvent as AnyAgentEvent;
  const timestamp = typed.timestamp ?? context.timestamp ?? Date.now();
  const id = typed.id ?? generateMessageId();
  const contextMeta = context.metadata;

  switch (typed.type) {
    case 'thought': {
      const thoughtEvent = agentEvent as AgentThoughtEvent;
      const content = thoughtEvent.content ?? '';
      const delta = thoughtEvent.delta;
      const isComplete = 'is_complete' in thoughtEvent ? Boolean(thoughtEvent.is_complete) : false;
      const thoughtMessageId =
        typeof thoughtEvent.thought_message_id === 'string' && thoughtEvent.thought_message_id.length > 0
          ? thoughtEvent.thought_message_id
          : undefined;
      
      // 🔥 只在思考完成时才持久化RuntimeEvent，保持与Chat模式一致
      // 注意：如果是增量更新且包含 delta，我们需要让它通过以便 SSE 发送
      if (options.skipIncomplete && !isComplete) {
        return null;
      }
      
      const runtimeEvent = createThoughtEvent(id, conversationId, turnId, content, {
        timestamp,
        thought_message_id: thoughtMessageId,
        delta,
        is_complete: isComplete
      });
      
      // 🔥 架构升级：标记增量思考为瞬时事件
      if (!isComplete) {
        runtimeEvent.ephemeral = true;
      }
      const thoughtMeta = isRecord(thoughtEvent.meta) ? thoughtEvent.meta : undefined;
      if (contextMeta || thoughtMeta) {
        runtimeEvent.metadata = { ...(runtimeEvent.metadata ?? {}), ...(contextMeta ?? {}), ...(thoughtMeta ?? {}) };
      }
      return runtimeEvent;
    }

    case 'tool_call_decision':
    case 'tool_process': {
      const toolEvent =
        typed.type === 'tool_call_decision'
          ? (typed as AgentToolCallDecisionEvent)
          : (typed as AgentToolProcessEvent);
      const toolName = toolEvent.tool_name || 'unknown_tool';
      const toolCallId = toolEvent.tool_call_id || `call_${id}`;
      const phase = toolEvent.phase ?? 'start';
      const status = toolEvent.status ?? 'loading';
      const args = toolEvent.tool_args || {};
      const payload = toolEvent.payload || {};
      
      const meta = toolEvent.meta && typeof toolEvent.meta === 'object' 
        ? { ...toolEvent.meta } 
        : {};
      const displayOptions = resolveToolDisplayOptions(toolName, options.toolPresentationPort);
      if (displayOptions && !meta.displayOptions) {
        meta.displayOptions = displayOptions;
      }

      const event =
        typed.type === 'tool_call_decision'
          ? createToolCallDecisionEvent(id, conversationId, turnId, toolName, toolCallId, {
              timestamp,
              phase,
              status,
              args,
              payload,
              meta,
            })
          : createToolProcessEvent(id, conversationId, turnId, toolName, toolCallId, {
              timestamp,
              phase,
              status,
              args,
              payload,
              meta,
            });
      event.ephemeral = meta.ephemeral === true;
      if (contextMeta) event.metadata = { ...(event.metadata ?? {}), ...contextMeta };
      return event;
    }

    case 'observation': {
      const observationEvent = agentEvent as AgentObservationEvent;
      const toolName = observationEvent.tool_name || 'unknown_tool';
      const toolCallId = observationEvent.tool_call_id || `call_${id}`;
      const success = observationEvent.success ?? !/^错误[:：]/i.test(String(observationEvent.output ?? ''));
      const status: 'success' | 'error' = success ? 'success' : 'error';
      const output = observationEvent.output;
      const payload = observationEvent.payload || {};
      const duration = payload.duration_ms as number | undefined;

      const event = createToolOutputEvent(id, conversationId, turnId, toolName, toolCallId, output, status, {
        timestamp,
        payload,
        duration_ms: duration
      });
      event.ephemeral = false; // 显式标记为非瞬时事件
      if (contextMeta) event.metadata = { ...(event.metadata ?? {}), ...contextMeta };
      return event;
    }

    case 'final_answer': {
      const finalAnswerEvent = agentEvent as AgentFinalAnswerEvent;
      const answer = finalAnswerEvent.answer ?? '';
      const answerIdFromSnake =
        typeof finalAnswerEvent.answer_id === 'string' && finalAnswerEvent.answer_id.trim().length > 0
          ? finalAnswerEvent.answer_id.trim()
          : undefined;
      const answerIdFromCamel = (() => {
        if (!isRecord(finalAnswerEvent)) return undefined;
        const v = finalAnswerEvent['answerId'];
        return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
      })();
      const answerId = answerIdFromSnake ?? answerIdFromCamel ?? `answer_${turnId}`;
      const meta = (() => {
        if (!isRecord(finalAnswerEvent)) return undefined;
        const v = finalAnswerEvent['meta'];
        return isRecord(v) ? (v as Record<string, unknown>) : undefined;
      })();
      
      return createFinalAnswerEvent(id, conversationId, turnId, answerId, answer, {
        timestamp,
        reasoning_details: Array.isArray(finalAnswerEvent.reasoning_details)
          ? finalAnswerEvent.reasoning_details
          : undefined,
        meta
      });
    }

    case 'error': {
      const errorEvent = agentEvent as AgentErrorEvent;
      const errorMessage = errorEvent.error ?? 'Unknown error';
      const details = errorEvent.details;
      
      return createErrorEvent(id, conversationId, turnId, errorMessage, {
        timestamp,
        details
      });
    }

    case 'stream_chunk': {
      // 🔥 统一架构：将 stream_chunk 转换为瞬时的 final_answer_chunk RuntimeEvent
      // 这个事件会通过 EventBus 流向 SsePort，但不会被持久化（FlowOrchestrator 会过滤）
      const streamEvent = typed as AgentStreamChunkEvent;
      const text = streamEvent.content ?? '';
      if (!text) {
        return null;
      }
      
      // 提取 answerId 和 seq（由 LlmNode 补充）
      const answerId = readAgentEventAnswerId(streamEvent) ?? `answer_${turnId}`;
      const seq = readAgentEventSeq(streamEvent) ?? 0;
      const isLast = Boolean(
        ('isLast' in streamEvent && streamEvent.isLast) || 
        ('is_last' in streamEvent && streamEvent.is_last)
      );
      
      const chunkEvent = createFinalAnswerChunkEvent(id, conversationId, turnId, answerId, seq, text, {
        timestamp,
        is_last: isLast
      });
      
      // 🔥 架构升级：标记为瞬时事件，不持久化
      chunkEvent.ephemeral = true;
      if (contextMeta) chunkEvent.metadata = { ...(chunkEvent.metadata ?? {}), ...contextMeta };
      return chunkEvent;
    }

    default:
      return null;
  }
}

// ================================================================
// 🔄 RuntimeEvent → ConversationMemoryPort 应用器
// ================================================================

/**
 * 将RuntimeEvent应用到ConversationMemoryPort（重建内存）
 * @param event 持久化的运行时事件
 * @param memory 要更新的会话内存
 */
export function applyRuntimeEventToMemory(event: RuntimeEvent, memory: ConversationMemoryPort): void {
  if (!event || !memory) {
    return;
  }

  switch (event.type) {
    case 'user_input': {
      const userEvent = event as RuntimeUserInputEvent;
      memory.addUserMessage(userEvent.content || '', userEvent.id);
      break;
    }

    case 'tool_call_decision': {
      const action = event as RuntimeToolCallDecisionEvent;
      const payload = action.payload || {};
      const toolCalls = Array.isArray(payload.tool_calls)
        ? payload.tool_calls.filter(isToolCallWire)
        : [];
      const toolArgs = action.args || payload.args || {};
      const toolCallId = action.tool_call_id || 
        (toolCalls.length > 0 ? toolCalls[0].id : `call_${event.id || Date.now()}`);

      const normalizedToolCalls: ToolCallWire[] = toolCalls.length > 0
        ? toolCalls
        : [
            {
              id: toolCallId,
              type: 'function',
              function: { name: action.tool_name, arguments: JSON.stringify(toolArgs || {}) }
            }
          ];
      const reasoningDetails = Array.isArray(payload.reasoning_details)
        ? payload.reasoning_details
        : undefined;

      memory.addAssistantMessage(
        null,
        'tool_calls',
        {
          tool_calls: normalizedToolCalls,
          ...(reasoningDetails ? { reasoning_details: reasoningDetails } : {}),
        },
        event.id,
      );
      break;
    }

    case 'tool_output': {
      const tool = event as RuntimeToolOutputEvent;
      if (tool.tool_call_id) {
        const payload = tool.payload || {};
        const outputValue = payload.result ?? payload.output ?? tool.output;
        let serializedOutput: string;
        if (typeof outputValue === 'string') {
          serializedOutput = outputValue;
        } else {
          try {
            serializedOutput = JSON.stringify(outputValue ?? '');
          } catch {
            serializedOutput = String(outputValue ?? '');
          }
        }
        memory.addToolResponse(String(tool.tool_call_id), serializedOutput, tool.tool_name, event.id);
      }
      break;
    }

    case 'final_answer': {
      const answerEvent = event as RuntimeFinalAnswerEvent;
      const answerContent = answerEvent.content || '';
      
      // 新架构：数据现在是干净的，无需解析<think>标签
      if (answerContent.trim()) {
        const metadata = Array.isArray(answerEvent.reasoning_details)
          ? { reasoning_details: answerEvent.reasoning_details }
          : undefined;
        memory.addAssistantMessage(answerContent, 'final_answer', metadata, answerEvent.id);
      }
      break;
    }

    case 'thought': {
      const thoughtEvent = event as RuntimeThoughtEvent;
      memory.addAssistantMessage(thoughtEvent.content || '', 'thought', undefined, thoughtEvent.id);
      break;
    }

    case 'history_summary': {
      const summaryEvent = event as RuntimeEvent & { 
        type: 'history_summary'; 
        content: string;
        replaces_start_message_id?: string;
        replaces_end_message_id?: string;
        original_message_count?: number;
        compression_ratio?: number;
        generated_by?: string;
        included_old_summary?: boolean;
        replaced_message_ids?: string[];
        summary_seq?: number;
      };
      
      // 🔥 关键修复：添加摘要消息到 memory，并保留所有 metadata（包括精确的ID列表和序列号）
      const summaryMetadata: AiMessage['metadata'] = {
        messageType: 'summary',
        generatedBy: summaryEvent.generated_by || 'AgentSummarizationProvider',
        originalMessageCount: summaryEvent.original_message_count,
        compressionRatio: summaryEvent.compression_ratio,
        includedOldSummary: summaryEvent.included_old_summary,
        replacesStartMessageId: summaryEvent.replaces_start_message_id,
        replacesEndMessageId: summaryEvent.replaces_end_message_id,
        replacedMessageIds: Array.isArray(summaryEvent.replaced_message_ids) ? summaryEvent.replaced_message_ids : [],
        summarySeq: summaryEvent.summary_seq || 0,
      };
      
      // 中文备注：
      // - history_summary 仍然回放为 system/history_summary 消息；
      // - 这里通过最小端口 `appendMessage` 写入，避免 core 反向依赖具体的会话实现。
      const summaryMessage: AiMessage = {
        id: summaryEvent.id,
        role: 'system',
        type: 'history_summary',
        content: summaryEvent.content || '',
        timestamp: summaryEvent.timestamp,
        metadata: summaryMetadata
      };
      
      memory.appendMessage(summaryMessage);
      break;
    }

    case 'error': {
      // 错误事件暂不写入memory，可根据需要调整
      break;
    }

    default:
      // 未知事件类型，忽略
      break;
  }
}

// ================================================================
// 🎯 统一导出的映射器对象
// ================================================================

/**
 * 统一的事件映射器
 * 提供所有事件转换功能的单一访问点
 */
export const eventMapper = {
  /**
   * 将AgentEvent转换为SSEEvent
   */
  agentToSse: agentEventToSSE,

  /**
   * 将AgentEvent转换为RuntimeEvent
   */
  agentToRuntime: agentEventToRuntime,

  /**
   * 将RuntimeEvent应用到ConversationMemoryPort
   */
  applyToMemory: applyRuntimeEventToMemory,

  /**
   * 批量处理AgentEvent → SSEEvent + RuntimeEvent
   * @param agentEvent 领域事件
   * @param context 转换上下文
   * @param options 转换选项
   * @returns 包含SSE和Runtime事件的对象
   */
  agentToBoth: (
    agentEvent: AnyAgentEvent,
    context: EventMappingContext,
    options: { sseOptions?: SSEMappingOptions; runtimeOptions?: RuntimeMappingOptions } = {}
  ) => {
    const sseEvent = agentEventToSSE(agentEvent, context, options.sseOptions);
    const runtimeEvent = agentEventToRuntime(agentEvent, context, options.runtimeOptions);
    return { sseEvent, runtimeEvent };
  },

  /**
   * 批量重建内存
   * @param events RuntimeEvent数组
   * @param memory 要更新的会话内存端口
   */
  rebuildMemory: (events: RuntimeEvent[], memory: ConversationMemoryPort) => {
    for (const event of events) {
      applyRuntimeEventToMemory(event, memory);
    }
  }
};

// ================================================================
// 🎯 类型已通过接口定义导出，无需重复导出
// ================================================================ 
