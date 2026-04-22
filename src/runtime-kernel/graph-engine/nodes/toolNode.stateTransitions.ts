import type { ToolControlInfo } from '../../tools/ui-types';
import type { UnknownRecord } from './toolNode.helpers';
import { isRecord } from './toolNode.helpers';
import type { RuntimeEvent } from '../../../contracts';

function mergeHistory(local: UnknownRecord, runtimeEvents: RuntimeEvent[]): RuntimeEvent[] {
  const history = (local.history as RuntimeEvent[]) || [];
  return [...history, ...runtimeEvents];
}

function stripAnswerState(local: UnknownRecord): UnknownRecord {
  const { answerId, chunkSeq, ...rest } = local;
  return rest;
}

export function readStructuredObservation(parsed: unknown): string | undefined {
  return isRecord(parsed) && typeof parsed.observation === 'string' ? parsed.observation : undefined;
}

export function extractToolControlInfo(parsed: unknown): ToolControlInfo | undefined {
  if (!isRecord(parsed) || !isRecord(parsed.control)) {
    return undefined;
  }

  const control = parsed.control;
  const requireUser = control.requireUser === true;
  const terminateRun = control.terminateRun === true;
  if (!requireUser && !terminateRun) {
    return undefined;
  }

  return {
    ...(requireUser ? { requireUser: true } : {}),
    ...(typeof control.questionnaireId === 'string' ? { questionnaireId: control.questionnaireId } : {}),
    ...(control.resumeStrategy === 'continue' ? { resumeStrategy: 'continue' } : {}),
    ...(terminateRun ? { terminateRun: true } : {}),
    ...(typeof control.reason === 'string' ? { reason: control.reason } : {}),
  };
}

export function buildSuccessOutputPayload(execResult: string | undefined, parsed: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    output: execResult ?? '',
  };
  if (parsed && typeof parsed === 'object') {
    payload.result = parsed;
  }
  return payload;
}

export function applyToolOutputIdempotencyMetadata(params: {
  runtimeToolOutput: RuntimeEvent | null;
  execIdempotency?: { key: string; cacheHit: boolean };
}): void {
  if (!params.runtimeToolOutput || !params.execIdempotency) {
    return;
  }

  if (params.execIdempotency.cacheHit) {
    params.runtimeToolOutput.ephemeral = true;
  }

  params.runtimeToolOutput.metadata = {
    ...(params.runtimeToolOutput.metadata ?? {}),
    idempotency: {
      key: params.execIdempotency.key,
      cache_hit: params.execIdempotency.cacheHit,
    },
  };
}

export function buildRequireUserLocalState(params: {
  local: UnknownRecord;
  parsed: unknown;
  toolCallId: string;
  toolName: string;
  remainingCalls: unknown[];
  conversationId: string;
  turnId: string;
  runtimeEvents: RuntimeEvent[];
}): UnknownRecord {
  return {
    ...params.local,
    pendingToolCalls: params.remainingCalls,
    pendingInteractionSpec: {
      ...(isRecord(params.parsed) && isRecord(params.parsed.control) ? params.parsed.control : {}),
      toolCallId: params.toolCallId,
      toolName: params.toolName,
    },
    lastToolResult: params.parsed as unknown,
    conversationId: params.conversationId,
    turnId: params.turnId,
    history: mergeHistory(params.local, params.runtimeEvents),
  };
}

export function buildSuccessLocalState(params: {
  local: UnknownRecord;
  remainingCalls: unknown[];
  conversationId: string;
  turnId: string;
  runtimeEvents: RuntimeEvent[];
}): UnknownRecord {
  return {
    ...stripAnswerState(params.local),
    pendingToolCalls: params.remainingCalls,
    conversationId: params.conversationId,
    turnId: params.turnId,
    history: mergeHistory(params.local, params.runtimeEvents),
  };
}

export function buildErrorLocalState(params: {
  local: UnknownRecord;
  remainingCalls: unknown[];
  conversationId: string;
  turnId: string;
  runtimeEvents: RuntimeEvent[];
  nextProtocolErrorCount: number;
}): UnknownRecord {
  const nextLocal: UnknownRecord = {
    ...stripAnswerState(params.local),
    pendingToolCalls: params.remainingCalls,
    conversationId: params.conversationId,
    turnId: params.turnId,
    history: mergeHistory(params.local, params.runtimeEvents),
  };

  if (params.nextProtocolErrorCount > 0) {
    nextLocal._consecutiveToolProtocolErrors = params.nextProtocolErrorCount;
  } else {
    delete nextLocal._consecutiveToolProtocolErrors;
  }

  return nextLocal;
}
