import type { EngineState, NodeResult, StandardToolCall } from '../types';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';
import type { ToolExecutionResult } from '../../tools/ports';
import { isRunPauseSignal, RunRecoveryBlockedError } from '../definitions/runContinuation';
import { parsePendingToolCalls } from '../functions/parsePendingToolCalls';
import type { ToolCallId } from '../../../contracts';

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

/**
 * 并行组内多个调用的断点提交必须排队：每次提交都以上一次的 revision 为基础，
 * 同时发起会让 Host 的 revision 校验失败或把两份快照写乱。
 */
export type BoundaryCommitQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createBoundaryCommitQueue(): BoundaryCommitQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    // 前一个提交失败不能卡住后面的调用；失败由各自的调用方处理。
    tail = next.catch(() => undefined);
    return next;
  };
}

export function readExecutingToolCallIds(state: EngineState): readonly ToolCallId[] {
  return state.local?.executingToolCallIds ?? [];
}

/** 在途意图必须是待执行调用的子集；否则断点已不一致，任何调用都不能据此继续。 */
export function assertExecutionIntentsArePending(state: EngineState): void {
  const executing = readExecutingToolCallIds(state);
  if (executing.length === 0) return;
  const pending = new Set(parsePendingToolCalls(state.local?.pendingToolCalls ?? []).map(call => call.id));
  if (executing.some(id => !pending.has(id))) {
    throw new RunRecoveryBlockedError('Pending tool identity does not match execution intent');
  }
}

export async function executeRecoverableTool(input: {
  readonly state: EngineState;
  readonly call: StandardToolCall;
  readonly context: ToolExecutionContext;
  readonly execute: () => Promise<ToolExecutionResult>;
  /** 默认 {@link DEFAULT_TOOL_ABORT_GRACE_MS}。 */
  readonly abortGraceMs?: number;
  readonly onAbandon?: () => void;
  /** 并行组的调用共用组内提交队列；串行调用不传，直接提交。 */
  readonly group?: { readonly commitQueue: BoundaryCommitQueue };
}): Promise<ToolExecutionResult> {
  const { state, call } = input;
  // 并行组里其他调用结算时会替换 state.local；这里每次都读最新对象，不能缓存。
  const run = (): Promise<ToolExecutionResult> => settleToolWithinAbortGrace({
    execution: input.execute(),
    signal: state.local?.signal,
    graceMs: input.abortGraceMs ?? DEFAULT_TOOL_ABORT_GRACE_MS,
    onAbandon: input.onAbandon,
  });
  if (!state.local?.commitExecutionBoundary) return run();
  const executing = readExecutingToolCallIds(state);
  if (!input.group && executing.some(id => id !== call.id)) {
    // 串行调用开始时不可能有别的调用在途。
    throw new RunRecoveryBlockedError('Pending tool identity does not match execution intent');
  }
  if (executing.includes(call.id)) {
    const decision = await state.local.toolRecoveryPort?.reconcile(call, input.context);
    if (!decision || decision.kind === 'blocked') {
      throw new RunRecoveryBlockedError(decision?.reason ?? `Tool outcome is unknown: ${call.id}`);
    }
    if (decision.kind === 'settled') return decision.result;
  }
  const commitIntent = async (): Promise<void> => {
    const local = state.local;
    if (!local?.commitExecutionBoundary) return;
    // 在排到提交时才登记意图：若提前写入，排在前面的其他提交会把一个尚未开始的调用记成在途，
    // 崩溃后它会被无谓地送去对账。
    local.executingToolCallIds = [...readExecutingToolCallIds(state).filter(id => id !== call.id), call.id];
    await local.commitExecutionBoundary(state);
  };
  // 动作开始前的记录必须成功；Audit、tool_process 或相同参数缓存不能代替此屏障。
  await (input.group ? input.group.commitQueue(commitIntent) : commitIntent());
  const result = await run();
  if (!result.success && isRunPauseSignal(state.local?.signal)) {
    const error = new Error('Tool execution paused before its outcome was confirmed');
    error.name = 'AbortError';
    throw error;
  }
  return result;
}

/** 结果已写入 state 的调用不再是待执行调用，其意图随同一次提交清除；仍在途的保留。 */
function pruneSettledExecutionIntents(state: EngineState): void {
  const local = state.local;
  if (!local) return;
  const pending = new Set(parsePendingToolCalls(local.pendingToolCalls ?? []).map(call => call.id));
  const remaining = readExecutingToolCallIds(state).filter(id => pending.has(id));
  if (remaining.length > 0) local.executingToolCallIds = remaining;
  else delete local.executingToolCallIds;
}

export async function commitToolBoundary(state: EngineState, result: NodeResult): Promise<void> {
  if (!state.local?.commitExecutionBoundary) return;
  pruneSettledExecutionIntents(state);
  state.nodeId = result.kind === 'route' ? (result.nextNodeId ?? 'user') : state.nodeId;
  state.executionStatus = result.kind === 'yield' ? 'yielded' : 'ready';
  await state.local.commitExecutionBoundary(state);
}
