import type { ChatMessage } from '../contracts';
import type { RuntimeEvent, AiMessage } from '../../../../contracts';

/**
 * 类型守卫：检查是否为 history_summary 事件
 */
function isHistorySummaryEvent(event: RuntimeEvent): event is RuntimeEvent & {
  type: 'history_summary';
  content: string;
  original_message_count?: number;
  compression_ratio?: number;
  generated_by?: string;
  included_old_summary?: boolean;
  replaced_message_ids?: string[];
  summary_seq?: number;
} {
  return 'type' in event && event.type === 'history_summary';
}

/**
 * 将 RuntimeEvent 转换为 ChatMessage
 * (供 HistoryBuilder 使用，用于 Chat 模式的历史构建)
 */
export function convertEventToChatMessage(event: RuntimeEvent): ChatMessage | null {
  console.debug('[Chat-eventConverter] 🛈 Incoming event', {
    id: event.id,
    type: event.type,
    hasMetadata: !!event.metadata,
    metadataKeys: event.metadata ? Object.keys(event.metadata) : [],
  });
  // 处理 history_summary (使用类型守卫)
  if (isHistorySummaryEvent(event)) {
    return {
      role: 'system',
      content: event.content || '',
      type: 'history_summary',
      id: event.id,
      timestamp: event.timestamp,
      metadata: {
        messageType: 'summary',
        originalMessageCount: event.original_message_count,
        compressionRatio: event.compression_ratio,
        generatedBy: event.generated_by,
        includedOldSummary: event.included_old_summary,
        replacedMessageIds: event.replaced_message_ids,
        summarySeq: event.summary_seq,
      }
    };
  }
  
  switch (event.type) {
    case 'user_input': {
      if (!event.content) return null;
      const metadata = event.metadata ? { ...event.metadata } : undefined;
      return {
        role: 'user',
        content: String(event.content),
        type: 'user_input',
        id: event.id,  // 🔥 保留 ID，用于历史净化的范围定位
        timestamp: event.timestamp,
        ...(metadata ? { metadata } : {}),
      };
    }
    
    case 'thought': {
      if (!event.content) return null;
      const metadata = event.metadata ? { ...event.metadata } : undefined;
      return {
        role: 'assistant',
        content: String(event.content),
        type: 'thought',
        id: event.id,  // 🔥 保留 ID
        timestamp: event.timestamp,
        ...(metadata ? { metadata } : {}),
      };
    }
    
    case 'final_answer': {
      if (!event.content) return null;
      const metadata = event.metadata ? { ...event.metadata } : undefined;
      return {
        role: 'assistant',
        content: String(event.content),
        type: 'final_answer',
        id: event.id,  // 🔥 保留 ID
        timestamp: event.timestamp,
        ...(metadata ? { metadata } : {}),
      };
    }
    
    // 🔥 Chat 模式下跳过工具调用事件（tool_call_decision / tool_process / tool_output）
    // 这些事件没有对应的 ChatMessage type，且 Chat 模式不需要展示工具调用细节
    case 'tool_call_decision':
    case 'tool_process':
    case 'tool_output':
      return null;

    // 🔥 UI-only 子过程过程流：即使落库也不进入 Chat 历史消息
    case 'subrun_trace':
      return null;
    
    default:
      // 对于未知类型，返回 null
      console.warn(`[Chat-eventConverter] Unsupported event type: ${event.type}`);
      return null;
  }
}

/**
 * 批量转换 RuntimeEvent 数组为 ChatMessage 数组
 * (用于 Chat 模式的历史构建)
 */
export function convertEventsToChatMessages(events: RuntimeEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  
  for (const event of events) {
    const message = convertEventToChatMessage(event);
    if (message) {
      messages.push(message);
      console.debug('[Chat-eventConverter] ✅ Converted event', {
        id: event.id,
        type: event.type,
        metadataKeys: message.metadata ? Object.keys(message.metadata) : [],
      });
    }
  }
  
  return messages;
}

/**
 * 将 ChatMessage 转换为 AiMessage
 * (用于将 ChatMessage 转换为内部使用的 AiMessage 格式)
 */
export function chatMessageToAiMessage(message: ChatMessage, options?: { id?: string; timestamp?: number }): AiMessage {
  return {
    id: message.id || options?.id || `msg-${Date.now()}`,
    role: message.role,
    type: message.type || 'final_answer',
    content: message.content,
    timestamp: message.timestamp || options?.timestamp || Date.now(),
    ...(message.metadata && { metadata: message.metadata })
  } as AiMessage;
}
