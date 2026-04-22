import { generateMessageId } from '../../../shared/ids';
import { splitConcatenatedJsonObjects, tryParseJsonRecord } from '../../llm/toolCallUtils';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';
import type { PendingContextRuntimeEvent } from '../executorContextBuilder';
import type { StandardToolCall } from '../types';
import type { LlmCallResponse, TickPipelineContext } from './types';
import type { RuntimeEvent } from '../../../contracts';

export function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveConversationIdForRuntimeEvents(toolContext: ToolExecutionContext | undefined): string {
  const fromCamel = readNonEmptyString(toolContext?.conversationId);
  if (fromCamel) return fromCamel;
  const fromSnake = toolContext ? readNonEmptyString(toolContext['conversation_id']) : undefined;
  if (fromSnake) return fromSnake;
  return generateMessageId();
}

export function extractResponseText(response: LlmCallResponse | undefined): string {
  if (!response) {
    return '';
  }
  if (typeof response === 'string') {
    return response;
  }
  return typeof response.content === 'string' ? response.content : '';
}

export function buildHistorySummaryRuntimeEvent(
  event: PendingContextRuntimeEvent,
  conversationId: string,
  turnId: string,
): RuntimeEvent {
  return {
    ...(event as Record<string, unknown>),
    conversation_id: conversationId,
    turn_id: turnId,
  } as RuntimeEvent;
}

export function isHistorySummaryEvent(event: PendingContextRuntimeEvent): boolean {
  return event.type === 'history_summary';
}

export function normalizeToolCalls(rawCalls: StandardToolCall[]): StandardToolCall[] {
  const expanded: StandardToolCall[] = [];
  for (const toolCall of rawCalls) {
    const argsRaw = toolCall.function?.arguments ?? '';
    const parsedDirectly = typeof argsRaw === 'string' && tryParseJsonRecord(argsRaw.trim()).ok;
    if (parsedDirectly) {
      expanded.push(toolCall);
      continue;
    }

    const pieces = typeof argsRaw === 'string' ? splitConcatenatedJsonObjects(argsRaw) : [];
    const validPieces = pieces.length >= 2 && pieces.every((piece) => tryParseJsonRecord(piece).ok);
    if (validPieces) {
      expanded.push({
        ...toolCall,
        function: { ...toolCall.function, arguments: pieces[0] },
      });
      for (let index = 1; index < pieces.length; index += 1) {
        expanded.push({
          ...toolCall,
          id: generateMessageId(),
          function: { ...toolCall.function, arguments: pieces[index] },
        });
      }
      continue;
    }

    expanded.push({
      ...toolCall,
    });
  }
  return expanded;
}

export function parsePrimaryToolArgs(toolCall: StandardToolCall | undefined): Record<string, unknown> {
  if (!toolCall?.function?.arguments) {
    return {};
  }
  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function resolveUsage(response: LlmCallResponse | undefined): unknown {
  if (!response || typeof response === 'string') {
    return undefined;
  }
  return response.usage;
}

export function resolveToolCalls(response: LlmCallResponse | undefined): StandardToolCall[] | undefined {
  if (!response || typeof response === 'string') {
    return undefined;
  }
  return Array.isArray(response.tool_calls) ? response.tool_calls : undefined;
}

export function resolveReasoningDetails(response: LlmCallResponse | undefined): unknown[] | undefined {
  if (!response || typeof response === 'string') {
    return undefined;
  }
  return Array.isArray(response.reasoning_details) ? response.reasoning_details : undefined;
}

export function resolveToolNamesForAudit(ctx: TickPipelineContext): string[] {
  if (ctx.forceFinalAnswer || ctx.request.enableTools === false || ctx.toolSchemas.length === 0) {
    return [];
  }
  return ctx.toolSchemas.map((tool) => tool.function.name);
}
