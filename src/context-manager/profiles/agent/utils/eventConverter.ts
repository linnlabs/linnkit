import { events as runtimeEvents } from '../../../../runtime-kernel';
import type { FinalAnswerEvent, RuntimeEvent, ToolOutputEvent, AiMessage } from '../../../../contracts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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

export function convertEventToAiMessage(event: RuntimeEvent): AiMessage {
  if (isHistorySummaryEvent(event)) {
    const replacedIds = Array.isArray(event.replaced_message_ids) ? event.replaced_message_ids : [];

    console.log('[Agent-eventConverter] 📋 摘要事件转换:', {
      summaryId: event.id,
      replacedCount: replacedIds.length,
      summarySeq: event.summary_seq,
      示例ID: replacedIds.slice(0, 3),
    });

    return {
      id: event.id,
      role: 'system',
      type: 'history_summary',
      content: event.content || '',
      timestamp: event.timestamp,
      metadata: {
        messageType: 'summary',
        originalMessageCount: event.original_message_count,
        compressionRatio: event.compression_ratio,
        generatedBy: event.generated_by,
        includedOldSummary: event.included_old_summary,
        replacedMessageIds: replacedIds,
        summarySeq: event.summary_seq,
      },
    };
  }

  switch (event.type) {
    case 'user_input':
      return {
        id: event.id,
        role: 'user',
        type: 'user_input',
        content: event.content || '',
        timestamp: event.timestamp,
      };

    case 'thought':
      return {
        id: event.id,
        role: 'assistant',
        type: 'thought',
        content: event.content || '',
        timestamp: event.timestamp,
      };

    case 'tool_call_decision':
      return {
        id: event.id,
        role: 'assistant',
        type: 'tool_calls',
        content: '',
        timestamp: event.timestamp,
        metadata: {
          tool_calls: (() => {
            type UnknownRecord = Record<string, unknown>;
            const isRecord = (v: unknown): v is UnknownRecord =>
              !!v && typeof v === 'object' && !Array.isArray(v);

            const payload = (event as { payload?: unknown }).payload;
            const toolCallsFromPayload = (() => {
              if (!isRecord(payload)) return undefined;
              const raw = payload['tool_calls'];
              return Array.isArray(raw) ? raw : undefined;
            })();

            if (toolCallsFromPayload && toolCallsFromPayload.length > 0) {
              return toolCallsFromPayload;
            }

            return [
              {
                id: event.tool_call_id || '',
                type: 'function' as const,
                function: {
                  name: event.tool_name || 'unknown',
                  arguments: JSON.stringify(event.args || {}),
                },
              },
            ];
          })(),
          reasoning_details: (() => {
            type UnknownRecord = Record<string, unknown>;
            const isRecord = (v: unknown): v is UnknownRecord =>
              !!v && typeof v === 'object' && !Array.isArray(v);
            const payload = (event as { payload?: unknown }).payload;
            if (!isRecord(payload)) return undefined;
            const rd = payload['reasoning_details'];
            return Array.isArray(rd) ? rd : undefined;
          })(),
        },
      };

    case 'tool_output': {
      const observationFromPayload = (() => {
        const payload = (event as ToolOutputEvent).payload;
        if (!isRecord(payload)) return undefined;
        const result = payload['result'];
        if (!isRecord(result)) return undefined;
        const obs = result['observation'];
        return typeof obs === 'string' && obs.trim().length > 0 ? obs : undefined;
      })();

      const rawOutput = (() => {
        const payload = (event as ToolOutputEvent).payload;
        if (isRecord(payload)) {
          const out = payload['output'];
          if (typeof out === 'string' && out.trim().length > 0) {
            return out;
          }
        }
        if (typeof event.output === 'string') {
          return event.output;
        }
        try {
          return JSON.stringify(event.output ?? '');
        } catch {
          return String(event.output ?? '');
        }
      })();

      const outputContent = observationFromPayload ?? rawOutput;

      return {
        id: event.id,
        role: 'tool',
        type: 'tool_output',
        content: outputContent,
        timestamp: event.timestamp,
        metadata: {
          tool_call_id: event.tool_call_id,
          tool_name: event.tool_name,
          raw_output: rawOutput,
          ...(observationFromPayload ? { observation: observationFromPayload } : {}),
        },
      };
    }

    case 'final_answer':
      return {
        id: event.id,
        role: 'assistant',
        type: 'final_answer',
        content: event.content || '',
        timestamp: event.timestamp,
      };

    default:
      console.warn(`[eventConverter] Unsupported event type: ${event.type}`);
      return {
        id: event.id,
        role: 'assistant',
        type: 'final_answer',
        content: '',
        timestamp: event.timestamp || Date.now(),
      };
  }
}

export function convertEventsToAiMessages(events: RuntimeEvent[]): AiMessage[] {
  const filtered = events.filter((event) => runtimeEvents.shouldEnterAgentContext(event));
  return filtered.map((event) => convertEventToAiMessage(event));
}

export function convertAiMessageToEvent(
  message: AiMessage,
  overrides?: Partial<RuntimeEvent>
): RuntimeEvent {
  const base = {
    id: message.id,
    timestamp: message.timestamp,
    conversation_id: '',
    turn_id: '',
    version: 1,
    ...overrides,
  };

  switch (message.role) {
    case 'user':
      return {
        ...base,
        type: 'user_input',
        content: message.content,
      } as RuntimeEvent;

    case 'tool':
      return {
        ...base,
        type: 'tool_output',
        tool_name: message.metadata?.tool_name || 'unknown',
        tool_call_id: message.metadata?.tool_call_id || '',
        output: message.metadata?.raw_output || message.content,
        status: 'success',
      } as RuntimeEvent;

    case 'assistant':
      if (message.type === 'thought') {
        return {
          ...base,
          type: 'thought',
          content: message.content,
        } as RuntimeEvent;
      }

      return {
        ...base,
        type: 'final_answer',
        content: message.content,
        answer_id: (overrides as Partial<FinalAnswerEvent> | undefined)?.answer_id,
        is_complete: true,
      } as RuntimeEvent;
    default:
      return {
        ...base,
        type: 'user_input',
        content: message.content,
      } as RuntimeEvent;
  }
}
