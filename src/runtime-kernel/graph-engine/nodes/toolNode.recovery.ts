import type { EngineState, NodeResult, StandardToolCall } from '../types';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';
import type { ToolExecutionResult } from '../../tools/ports';
import { isRunPauseSignal, RunRecoveryBlockedError } from '../definitions/runContinuation';

/** 停止信号发出后，等工具自行结束的最长时间。 */
export const DEFAULT_TOOL_ABORT_GRACE_MS = 3_000;

/**
 * 暂停或取消后，工具必须在期限内结束；不理会停止信号的工具按 AbortError 处理，走与“工具自己响应停止”相同的路径。
 * 迟到的结果没有归属，直接丢弃，不进入历史。期限只从停止信号发出时开始计时，不限制工具正常运行时长。
 */
export function settleToolWithinAbortGrace<T>(input: {
  readonly execution: Promise<T>;
  readonly signal: AbortSignal | undefined;
  readonly graceMs: number;
  readonly onAbandon?: () => void;
}): Promise<T> {
  const { execution, signal, graceMs } = input;
  if (!signal) return execution;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', startGrace);
    };
    function startGrace(): void {
      timer = setTimeout(() => {
        cleanup();
        execution.catch(() => undefined);
        input.onAbandon?.();
        const error = new Error('Tool did not stop within the abort grace period; its late outcome is discarded.');
        error.name = 'AbortError';
        reject(error);
      }, graceMs);
    }
    if (signal.aborted) startGrace();
    else signal.addEventListener('abort', startGrace, { once: true });
    execution.then(
      value => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

export async function executeRecoverableTool(input: {
  readonly state: EngineState;
  readonly call: StandardToolCall;
  readonly context: ToolExecutionContext;
  readonly execute: () => Promise<ToolExecutionResult>;
  /** 默认 {@link DEFAULT_TOOL_ABORT_GRACE_MS}。 */
  readonly abortGraceMs?: number;
  readonly onAbandon?: () => void;
}): Promise<ToolExecutionResult> {
  const local = input.state.local;
  const run = (): Promise<ToolExecutionResult> => settleToolWithinAbortGrace({
    execution: input.execute(),
    signal: local?.signal,
    graceMs: input.abortGraceMs ?? DEFAULT_TOOL_ABORT_GRACE_MS,
    onAbandon: input.onAbandon,
  });
  if (!local?.commitExecutionBoundary) return run();
  if (local.executingToolCallId) {
    if (local.executingToolCallId !== input.call.id) {
      throw new RunRecoveryBlockedError('Pending tool identity does not match execution intent');
    }
    const decision = await local.toolRecoveryPort?.reconcile(input.call, input.context);
    if (!decision || decision.kind === 'blocked') {
      throw new RunRecoveryBlockedError(decision?.reason ?? `Tool outcome is unknown: ${input.call.id}`);
    }
    if (decision.kind === 'settled') return decision.result;
  }
  local.executingToolCallId = input.call.id;
  // 动作开始前的记录必须成功；Audit、tool_process 或相同参数缓存不能代替此屏障。
  await local.commitExecutionBoundary(input.state);
  const result = await run();
  if (!result.success && isRunPauseSignal(local.signal)) {
    const error = new Error('Tool execution paused before its outcome was confirmed');
    error.name = 'AbortError';
    throw error;
  }
  return result;
}

export async function commitToolBoundary(state: EngineState, result: NodeResult): Promise<void> {
  if (!state.local?.commitExecutionBoundary) return;
  delete state.local.executingToolCallId;
  state.nodeId = result.kind === 'route' ? (result.nextNodeId ?? 'user') : state.nodeId;
  state.executionStatus = result.kind === 'yield' ? 'yielded' : 'ready';
  await state.local.commitExecutionBoundary(state);
}
