import { events as runtimeEvents } from '../../../../runtime-kernel';
import {
  FinalAnswerCompletionReason,
  ProviderReasoningDetailsPayload,
  RuntimeEvent,
  ToolOutputMeta,
  type AiMessage,
  type FinalAnswerEvent,
  type ObservationTruncationMeta,
  type ThoughtEvent,
  type UserInputEvent,
} from '../../../../contracts';
import { Logger } from '../../../../shared/logger';

const logger = new Logger('AgentEventConverter');

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readObservationTruncationMeta(value: unknown): ObservationTruncationMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const originalChars = value['originalChars'];
  const previewChars = value['previewChars'];
  if (typeof originalChars !== 'number' || !Number.isInteger(originalChars) || originalChars < 0) {
    return undefined;
  }
  if (typeof previewChars !== 'number' || !Number.isInteger(previewChars) || previewChars < 0) {
    return undefined;
  }
  const originalLines = value['originalLines'];
  const previewLines = value['previewLines'];
  const blobId = value['blobId'];
  return {
    ...(typeof blobId === 'string' && blobId.trim() ? { blobId: blobId.trim() } : {}),
    originalChars,
    previewChars,
    ...(typeof originalLines === 'number' && Number.isInteger(originalLines) && originalLines >= 0
      ? { originalLines }
      : {}),
    ...(typeof previewLines === 'number' && Number.isInteger(previewLines) && previewLines >= 0
      ? { previewLines }
      : {}),
  };
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

    logger.debug('Converted history_summary RuntimeEvent to AiMessage', {
      summaryId: event.id,
      replacedCount: replacedIds.length,
      summarySeq: event.summary_seq,
      sampleIds: replacedIds.slice(0, 3),
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
        ...(event.attachments ? { attachments: event.attachments } : {}),
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
      const observationTruncation = readObservationTruncationMeta(event.metadata?.observationTruncation);

      return {
        id: event.id,
        role: 'tool',
        type: 'tool_output',
        content: event.observation,
        timestamp: event.timestamp,
        metadata: {
          tool_call_id: event.tool_call_id,
          tool_name: event.tool_name,
          ...(event.data !== undefined ? { data: event.data } : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(event.metadata?.presentation !== undefined
            ? { presentation: event.metadata.presentation }
            : {}),
          ...(observationTruncation ? { observationTruncation } : {}),
        },
        ...(event.attachments ? { attachments: event.attachments } : {}),
      };
    }

    case 'final_answer':
      return {
        id: event.id,
        role: 'assistant',
        type: 'final_answer',
        content: event.content || '',
        timestamp: event.timestamp,
        metadata: {
          completion_reason: event.completion_reason,
          reasoning_details: Array.isArray(event.reasoning_details) ? event.reasoning_details : undefined,
        },
      };

    default:
      throw new Error(`Unsupported RuntimeEvent type during AiMessage conversion: ${event.type}`);
  }
}

export function convertEventsToAiMessages(events: RuntimeEvent[]): AiMessage[] {
  const filtered = events.filter((event) => runtimeEvents.shouldEnterAgentContext(event));
  return filtered.map((event) => convertEventToAiMessage(event));
}

interface AiMessageEventContext {
  conversation_id: string;
  turn_id: string;
  timestamp?: number;
  metadata?: RuntimeEvent['metadata'];
  ephemeral?: boolean;
}

export function convertAiMessageToEvent(
  message: AiMessage,
  context: AiMessageEventContext,
): RuntimeEvent {
  const base: Pick<
    UserInputEvent,
    'id' | 'timestamp' | 'conversation_id' | 'turn_id' | 'version' | 'metadata' | 'ephemeral'
  > = {
    id: message.id,
    timestamp: context.timestamp ?? message.timestamp,
    conversation_id: context.conversation_id,
    turn_id: context.turn_id,
    version: 1,
    ...(context.metadata ? { metadata: context.metadata } : {}),
    ...(context.ephemeral !== undefined ? { ephemeral: context.ephemeral } : {}),
  };

  switch (message.role) {
    case 'user': {
      const event: UserInputEvent = {
        ...base,
        type: 'user_input',
        content: message.content,
        source: 'user',
        ...(message.type === 'user_input' && message.attachments
          ? { attachments: message.attachments }
          : {}),
      };
      return event;
    }

    case 'tool': {
      const toolMetadata = ToolOutputMeta.parse(message.metadata);
      const result = typeof message.metadata?.error === 'string'
        ? {
            status: 'error' as const,
            observation: message.content,
            error: message.metadata.error,
          }
        : {
            status: 'success' as const,
            observation: message.content,
            data: message.metadata?.data,
          };
      return RuntimeEvent.parse({
        ...base,
        type: 'tool_output',
        tool_name: toolMetadata.tool_name,
        tool_call_id: toolMetadata.tool_call_id,
        ...result,
        ...(message.metadata?.presentation !== undefined
          ? { metadata: { ...(base.metadata ?? {}), presentation: message.metadata.presentation } }
          : {}),
        ...(message.attachments ? { attachments: message.attachments } : {}),
      });
    }

    case 'assistant': {
      if (message.type === 'thought') {
        const event: ThoughtEvent = {
          ...base,
          type: 'thought',
          content: message.content,
          is_complete: true,
        };
        return event;
      }
      if (message.type !== 'final_answer') {
        throw new Error(`AiMessage type ${message.type} cannot be converted to a RuntimeEvent.`);
      }

      const rawReasoningDetails = message.metadata?.reasoning_details;
      const completionReason = FinalAnswerCompletionReason.parse(message.metadata?.completion_reason);
      const event: FinalAnswerEvent = {
        ...base,
        type: 'final_answer',
        content: message.content,
        answer_id: message.id,
        completion_reason: completionReason,
        is_complete: completionReason !== 'interrupted',
        ...(Array.isArray(rawReasoningDetails)
          ? { reasoning_details: ProviderReasoningDetailsPayload.parse(rawReasoningDetails) }
          : {}),
      };
      return event;
    }

    case 'system': {
      const event: UserInputEvent = {
        ...base,
        type: 'user_input',
        content: message.content,
        source: 'system',
      };
      return event;
    }
  }
}
