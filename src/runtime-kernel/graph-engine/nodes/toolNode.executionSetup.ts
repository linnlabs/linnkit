import { normalizeToolArgs } from '../../tools/argNormalizer';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';
import { computeToolIdempotencyKey } from '../../tools/idempotency/toolIdempotency';
import type { ToolCatalogPort, ToolRuntimeDefinition } from '../../tools/ports';
import { ensureToolContextRuntimeCapability } from '../../tools/toolContextRuntime';
import type { EngineState, StandardToolCall } from '../types';
import { ToolNodeEventBridge } from './toolNode.eventBridge';
import { computeCitationOffset, isRecord, parseJsonSafe, type UnknownRecord } from './toolNode.helpers';
import type { RuntimeEvent } from '../../../contracts';

export type PreparedToolNodeContext = {
  state: EngineState;
  local: UnknownRecord;
  toolContext: ToolExecutionContext;
  conversationId: string;
  turnId: string;
};

export type PreparedToolExecution = {
  call: StandardToolCall;
  toolName: string;
  toolCallId: string;
  rawArguments: string;
  toolArgs: Record<string, unknown>;
  protocolError?: string;
  bridge: ToolNodeEventBridge;
};

type ParsedToolArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseToolArgs(call: StandardToolCall): ParsedToolArgsResult {
  const rawArguments = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
  if (!rawArguments.trim()) {
    return {
      ok: false,
      error: 'Tool arguments must be a non-empty JSON object string.',
    };
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (!isRecord(parsed)) {
      return {
        ok: false,
        error: 'Tool arguments must decode to a JSON object.',
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown JSON parse error';
    console.warn('[ToolNode] Failed to parse tool arguments:', error);
    return {
      ok: false,
      error: `Tool arguments are not valid JSON: ${reason}`,
    };
  }
}

export function prepareToolNodeContext(state: EngineState): PreparedToolNodeContext {
  const local: UnknownRecord = state.local || {};
  const toolContext: ToolExecutionContext = isRecord(local.toolContext)
    ? (local.toolContext as ToolExecutionContext)
    : {};
  if (!isRecord(local.toolContext)) {
    local.toolContext = toolContext as UnknownRecord;
  }

  const conversationId = typeof local.conversationId === 'string' ? local.conversationId : '';
  const turnId =
    typeof local.turnId === 'string'
      ? local.turnId
      : `turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  local.turnId = turnId;

  const historyEvents = (local.history as RuntimeEvent[]) || [];
  const citationOffset = computeCitationOffset(historyEvents, turnId);
  const existingConversationId =
    typeof toolContext.conversationId === 'string' ? toolContext.conversationId.trim() : '';
  ensureToolContextRuntimeCapability({
    context: toolContext,
    executionMeta: {
      conversationId: existingConversationId || conversationId,
      turnId,
      citationOffset,
    },
  });
  attachWorkingHistoryView({ state, toolContext });

  return { state, local, toolContext, conversationId, turnId };
}

export function prepareToolExecution(params: {
  prepared: PreparedToolNodeContext;
  call: StandardToolCall;
  toolCatalog?: Pick<ToolCatalogPort, 'getToolDefinition'>;
}): PreparedToolExecution | null {
  const toolName = params.call.function?.name;
  if (!toolName) {
    return null;
  }

  const toolCallId = params.call.id;
  const rawArguments = typeof params.call.function?.arguments === 'string' ? params.call.function.arguments : '';
  let toolArgs: Record<string, unknown> = {};
  let protocolError: string | undefined;
  const parsedToolArgs = parseToolArgs(params.call);
  const toolCatalog = params.toolCatalog;
  const toolDefinition = toolCatalog?.getToolDefinition(toolName);
  if (parsedToolArgs.ok) {
    toolArgs = parsedToolArgs.value;
  } else {
    protocolError = parsedToolArgs.error;
  }

  if (!protocolError && toolDefinition) {
    toolArgs = normalizeToolArgs(toolDefinition.parameters, toolArgs, { toolName });
  }

  const displayOptions = (toolDefinition?.displayOptions ?? {}) as Record<string, unknown>;
  const idempotencyKey = protocolError
    ? undefined
    : computeIdempotencyKey({
        toolDefinition,
        toolName,
        toolArgs,
        toolContext: params.prepared.toolContext,
      });

  bindRuntimeToolContext({
    toolContext: params.prepared.toolContext,
    conversationId: params.prepared.conversationId,
    turnId: params.prepared.turnId,
    toolCallId,
  });

  const sseSink =
    typeof params.prepared.local.sseSink === 'function'
      ? (params.prepared.local.sseSink as (evt: unknown) => void)
      : undefined;
  const bridge = new ToolNodeEventBridge({
    sseSink,
    conversationId: params.prepared.conversationId,
    turnId: params.prepared.turnId,
    toolName,
    toolCallId,
    toolArgs,
    displayOptions,
    idempotencyKey,
  });

  return {
    call: params.call,
    toolName,
    toolCallId,
    rawArguments,
    toolArgs,
    protocolError,
    bridge,
  };
}

function attachWorkingHistoryView(params: {
  state: EngineState;
  toolContext: ToolExecutionContext;
}): void {
  const historyEvents = ((params.state.local as UnknownRecord | undefined)?.history as RuntimeEvent[] | undefined) ?? [];
  const runtimeBinding = ensureToolContextRuntimeCapability({
    context: params.toolContext,
    workingHistory: historyEvents,
  });
  runtimeBinding.setWorkingHistorySource(() => {
    const currentLocal = params.state.local as UnknownRecord | undefined;
    const currentHistory = (currentLocal?.history as RuntimeEvent[] | undefined) ?? [];
    if (Array.isArray(currentHistory) && currentHistory.length > 0) {
      return currentHistory;
    }
    return runtimeBinding.getPersistedHistoryEvents();
  });
}

function computeIdempotencyKey(params: {
  toolDefinition: ToolRuntimeDefinition | undefined;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolContext: ToolExecutionContext;
}): string | undefined {
  if (!params.toolDefinition?.idempotency) {
    return undefined;
  }

  try {
    return computeToolIdempotencyKey({
      policy: params.toolDefinition.idempotency,
      toolName: params.toolName,
      args: params.toolArgs,
      context: params.toolContext,
    });
  } catch {
    return undefined;
  }
}

function bindRuntimeToolContext(params: {
  toolContext: ToolExecutionContext;
  conversationId: string;
  turnId: string;
  toolCallId: string;
}): void {
  const existingConversationId =
    typeof params.toolContext.conversationId === 'string' ? params.toolContext.conversationId.trim() : '';
  ensureToolContextRuntimeCapability({
    context: params.toolContext,
    executionMeta: {
      conversationId: existingConversationId || params.conversationId,
      turnId: params.turnId,
      parentToolCallId: params.toolCallId,
      citationOffset:
        typeof params.toolContext.citationOffset === 'number' && Number.isFinite(params.toolContext.citationOffset)
          ? params.toolContext.citationOffset
          : undefined,
    },
  });
}

export { parseJsonSafe };
