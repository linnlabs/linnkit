import type { EngineState, StandardToolCall } from '../types';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';
import type { ToolExecutionResult } from '../../tools/ports';

/** Host 在同一次提交中持久化已接纳事实与断点；不得跨 Provider / tool 调用持有事务。 */
export interface ExecutionCheckpointPort {
  commit(checkpointKey: string, checkpoint: EngineState): Promise<void>;
}

export type ToolRecoveryDecision =
  | { readonly kind: 'retry' }
  | { readonly kind: 'settled'; readonly result: ToolExecutionResult }
  | { readonly kind: 'blocked'; readonly reason: string };

/** 只有工具 owner 能证明未决外部动作的结果；参数相同不构成完成证据。 */
export interface ToolRecoveryPort {
  reconcile(call: StandardToolCall, context: ToolExecutionContext): Promise<ToolRecoveryDecision>;
}

export class RunRecoveryBlockedError extends Error {
  readonly code = 'RUN_RECOVERY_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'RunRecoveryBlockedError';
  }
}

/** 可恢复中断与永久取消使用不同 signal reason，不为暂停补造工具失败终态。 */
export class RunPauseRequested extends Error {
  readonly code = 'RUN_PAUSE_REQUESTED';
  constructor(message = 'Run paused by user') {
    super(message);
    this.name = 'RunPauseRequested';
  }
}

export function isRunPauseSignal(signal: AbortSignal | undefined): boolean {
  const reason: unknown = signal?.reason;
  // npm 各入口可能各自打包类；协议身份不能依赖跨 bundle 的 instanceof。
  return signal?.aborted === true && typeof reason === 'object' && reason !== null
    && 'code' in reason && reason.code === 'RUN_PAUSE_REQUESTED';
}
