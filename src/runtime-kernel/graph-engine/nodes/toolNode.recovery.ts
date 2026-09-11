import type { EngineState, NodeResult, StandardToolCall } from '../types';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';
import type { ToolExecutionResult } from '../../tools/ports';
import { isRunPauseSignal, RunRecoveryBlockedError } from '../definitions/runContinuation';

export async function executeRecoverableTool(input: {
  readonly state: EngineState;
  readonly call: StandardToolCall;
  readonly context: ToolExecutionContext;
  readonly execute: () => Promise<ToolExecutionResult>;
}): Promise<ToolExecutionResult> {
  const local = input.state.local;
  if (!local?.commitExecutionBoundary) return input.execute();
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
  const result = await input.execute();
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
