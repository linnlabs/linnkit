import { recordToolProtocolError } from '../../../shared/llmAuditRecorder';

export const TOOL_PROTOCOL_ERROR_FUSE_THRESHOLD = 4;

type ProtocolExecLike = {
  errorKind?: 'protocol' | 'execution';
  error?: string;
};

export function applyProtocolFuseState(local: Record<string, unknown>, nextCount: number): void {
  if (nextCount > 0) {
    local._consecutiveToolProtocolErrors = nextCount;
    return;
  }

  delete local._consecutiveToolProtocolErrors;
}

export function checkProtocolFuse(params: {
  local: Record<string, unknown>;
  exec: ProtocolExecLike;
  toolName: string;
  toolCallId?: string;
  rawArguments?: string;
  parsedArguments: Record<string, unknown>;
}): { isProtocolError: boolean; nextCount: number; shouldFuse: boolean } {
  const isProtocolError = params.exec.errorKind === 'protocol';

  if (isProtocolError) {
    recordToolProtocolError({
      mode: 'agent',
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      rawArguments: params.rawArguments,
      parsedArguments: params.parsedArguments,
      error: params.exec.error ?? 'unknown protocol error',
    });
  }

  const previousCount =
    typeof params.local._consecutiveToolProtocolErrors === 'number'
      ? (params.local._consecutiveToolProtocolErrors as number)
      : 0;
  const nextCount = isProtocolError ? previousCount + 1 : 0;

  return {
    isProtocolError,
    nextCount,
    shouldFuse: isProtocolError && nextCount >= TOOL_PROTOCOL_ERROR_FUSE_THRESHOLD,
  };
}

export function createToolProtocolFuseError(nextCount: number, error: string | undefined): Error {
  const fuseError = new Error(
    `[ToolNode] Consecutive tool protocol errors reached fuse threshold (${nextCount}): ${error ?? 'unknown protocol error'}`
  );
  fuseError.name = 'ToolProtocolFuseError';
  return fuseError;
}
