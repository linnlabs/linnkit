import type {
  AiMessage,
  RuntimeEvent,
  ThoughtEvent as RuntimeThoughtEvent,
  ToolCallDecisionEvent as RuntimeToolCallDecisionEvent,
  ToolOutputEvent as RuntimeToolOutputEvent,
  FinalAnswerEvent as RuntimeFinalAnswerEvent,
  UserInputEvent as RuntimeUserInputEvent,
  ToolCallWire,
} from '../../contracts';
import {
  type ConversationMemoryPort,
  type HistorySummaryRuntimeEvent,
  isToolCallWire,
} from './provider-sidecar';

export function applyRuntimeEventToMemory(event: RuntimeEvent, memory: ConversationMemoryPort): void {
  if (!event || !memory) return;

  switch (event.type) {
    case 'user_input': {
      const userEvent = event as RuntimeUserInputEvent;
      memory.addUserMessage(userEvent.content || '', userEvent.id);
      break;
    }

    case 'tool_call_decision':
      applyToolCallDecision(event as RuntimeToolCallDecisionEvent, memory);
      break;

    case 'tool_output':
      applyToolOutput(event as RuntimeToolOutputEvent, memory);
      break;

    case 'final_answer': {
      const answerEvent = event as RuntimeFinalAnswerEvent;
      const answerContent = answerEvent.content || '';
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

    case 'history_summary':
      applyHistorySummary(event as HistorySummaryRuntimeEvent, memory);
      break;

    case 'error':
      break;

    default:
      break;
  }
}

function applyToolCallDecision(event: RuntimeToolCallDecisionEvent, memory: ConversationMemoryPort): void {
  const payload = event.payload || {};
  const toolCalls = Array.isArray(payload.tool_calls)
    ? payload.tool_calls.filter(isToolCallWire)
    : [];
  const toolArgs = event.args || payload.args || {};
  const toolCallId = event.tool_call_id ||
    (toolCalls.length > 0 ? toolCalls[0].id : `call_${event.id || Date.now()}`);

  const normalizedToolCalls: ToolCallWire[] = toolCalls.length > 0
    ? toolCalls
    : [
        {
          id: toolCallId,
          type: 'function',
          function: { name: event.tool_name, arguments: JSON.stringify(toolArgs || {}) },
        },
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
}

function applyToolOutput(event: RuntimeToolOutputEvent, memory: ConversationMemoryPort): void {
  if (!event.tool_call_id) return;
  const payload = event.payload || {};
  const outputValue = payload.result ?? payload.output ?? event.output;
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
  memory.addToolResponse(String(event.tool_call_id), serializedOutput, event.tool_name, event.id);
}

function applyHistorySummary(summaryEvent: HistorySummaryRuntimeEvent, memory: ConversationMemoryPort): void {
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

  const summaryMessage: AiMessage = {
    id: summaryEvent.id,
    role: 'system',
    type: 'history_summary',
    content: summaryEvent.content || '',
    timestamp: summaryEvent.timestamp,
    metadata: summaryMetadata,
  };

  memory.appendMessage(summaryMessage);
}
