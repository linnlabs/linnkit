/**
 * @file src/agent/runtime-kernel/events/eventMappers.ts
 * @brief 统一事件映射器兼容出口
 *
 * @description
 * 具体职责已拆分：
 * - sse-projection.ts：AnyAgentEvent → SSEEvent
 * - agent-to-runtime.ts：AnyAgentEvent → RuntimeEvent
 * - runtime-to-ai-message.ts：RuntimeEvent → ConversationMemoryPort
 * - provider-sidecar.ts：sidecar/tool_call/displayOptions 相关共享工具与类型
 */

import type { AnyAgentEvent } from './agentEvents';
import type { RuntimeEvent } from '../../contracts';
import { agentEventToRuntime } from './agent-to-runtime';
import {
  type ConversationMemoryPort,
  type EventMappingContext,
  type RuntimeMappingOptions,
  type SSEMappingOptions,
} from './provider-sidecar';
import { applyRuntimeEventToMemory } from './runtime-to-ai-message';
import { agentEventToSSE } from './sse-projection';

export { agentEventToRuntime } from './agent-to-runtime';
export {
  type ConversationMemoryPort,
  type EventMappingContext,
  type RuntimeMappingOptions,
  type SSEMappingOptions,
} from './provider-sidecar';
export { applyRuntimeEventToMemory } from './runtime-to-ai-message';
export { agentEventToSSE } from './sse-projection';

/**
 * 统一的事件映射器。
 *
 * 中文备注：
 * - 保持旧调用方式 `eventMapper.xxx` 不变；
 * - 新逻辑不要继续写回本文件，按职责放到拆分后的模块。
 */
export const eventMapper = {
  /**
   * 将 AgentEvent 转换为 SSEEvent。
   */
  agentToSse: agentEventToSSE,

  /**
   * 将 AgentEvent 转换为 RuntimeEvent。
   */
  agentToRuntime: agentEventToRuntime,

  /**
   * 将 RuntimeEvent 应用到 ConversationMemoryPort。
   */
  applyToMemory: applyRuntimeEventToMemory,

  /**
   * 批量处理 AgentEvent → SSEEvent + RuntimeEvent。
   */
  agentToBoth: (
    agentEvent: AnyAgentEvent,
    context: EventMappingContext,
    options: { sseOptions?: SSEMappingOptions; runtimeOptions?: RuntimeMappingOptions } = {},
  ) => {
    const sseEvent = agentEventToSSE(agentEvent, context, options.sseOptions);
    const runtimeEvent = agentEventToRuntime(agentEvent, context, options.runtimeOptions);
    return { sseEvent, runtimeEvent };
  },

  /**
   * 批量重建内存。
   */
  rebuildMemory: (events: RuntimeEvent[], memory: ConversationMemoryPort) => {
    for (const event of events) {
      applyRuntimeEventToMemory(event, memory);
    }
  },
};
