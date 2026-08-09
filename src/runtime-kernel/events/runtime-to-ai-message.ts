import {
  ToolCallWire as ToolCallWireSchema,
  type ToolCallWire,
} from '../../contracts';
import type {
  AiMessage,
  HistorySummaryEvent,
  RuntimeEvent,
  ToolCallDecisionEvent as RuntimeToolCallDecisionEvent,
  ToolOutputEvent as RuntimeToolOutputEvent,
} from '../../contracts';
import { type ConversationMemoryPort } from './provider-sidecar';

export function applyRuntimeEventToMemory(event: RuntimeEvent, memory: ConversationMemoryPort): void {
  switch (event.type) {
    case 'user_input': {
      memory.addUserMessage(event.content, event.id, event.attachments);
      break;
    }

    case 'tool_call_decision':
      applyToolCallDecision(event, memory);
      break;

    case 'tool_output':
      applyToolOutput(event, memory);
      break;

    case 'final_answer': {
      if (event.content.trim()) {
        const metadata = {
          completion_reason: event.completion_reason,
          ...(Array.isArray(event.reasoning_details)
            ? { reasoning_details: event.reasoning_details }
            : {}),
        };
        memory.addAssistantMessage(event.content, 'final_answer', metadata, event.id);
      }
      break;
    }

    case 'thought': {
      memory.addAssistantMessage(event.content, 'thought', undefined, event.id);
      break;
    }

    case 'history_summary':
      applyHistorySummary(event, memory);
      break;

    case 'error':
      break;

    default:
      break;
  }
}

function applyToolCallDecision(event: RuntimeToolCallDecisionEvent, memory: ConversationMemoryPort): void {
  const payload = event.payload || {};
  const toolCalls: ToolCallWire[] = Array.isArray(payload.tool_calls)
    ? payload.tool_calls.map((toolCall) => ToolCallWireSchema.parse(toolCall))
    : [];
  const toolArgs = event.args || payload.args || {};

  const normalizedToolCalls: ToolCallWire[] = toolCalls.length > 0
    ? toolCalls
    : [{
        id: event.tool_call_id,
        type: 'function',
        function: { name: event.tool_name, arguments: JSON.stringify(toolArgs || {}) },
      }];
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
}

function applyToolOutput(event: RuntimeToolOutputEvent, memory: ConversationMemoryPort): void {
  memory.addToolResponse(
    event.tool_call_id,
    event.observation,
    event.tool_name,
    event.id,
    event.attachments,
    {
      ...(event.data !== undefined ? { data: event.data } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
      ...(event.metadata?.presentation !== undefined
        ? { presentation: event.metadata.presentation }
        : {}),
    },
  );
}

function applyHistorySummary(summaryEvent: HistorySummaryEvent, memory: ConversationMemoryPort): void {
  const summaryMetadata: AiMessage['metadata'] = {
    messageType: 'summary',
    originalMessageCount: summaryEvent.original_message_count,
    compressionRatio: summaryEvent.compression_ratio,
    includedOldSummary: summaryEvent.included_old_summary,
    replacedMessageIds: summaryEvent.replaced_message_ids,
    summarySeq: summaryEvent.summary_seq,
  };

  const summaryMessage: AiMessage = {
    id: summaryEvent.id,
    role: 'system',
    type: 'history_summary',
    content: summaryEvent.content,
    timestamp: summaryEvent.timestamp,
    metadata: summaryMetadata,
  };

  memory.appendMessage(summaryMessage);
}
