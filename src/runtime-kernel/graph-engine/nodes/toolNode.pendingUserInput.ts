import {
  createUserInputEvent,
  parseRuntimeEvents,
  type RoutedRuntimeEvent,
} from '../../../contracts';
import type { EngineState, NodeResult } from '../types';
import type { PendingUserInputPort } from '../definitions/pendingUserInput';
import { requireRuntimeEventSink } from '../graphLocal';
import { appendWorkingHistory } from '../functions/appendWorkingHistory';
import { isRunPauseSignal } from '../definitions/runContinuation';

export interface ClaimedPendingUserInputs {
  readonly events: RoutedRuntimeEvent[];
  confirm(): Promise<void>;
  release(): Promise<void>;
}

function isPendingUserInputPort(value: unknown): value is PendingUserInputPort {
  return !!value && typeof value === 'object'
    && typeof Reflect.get(value, 'claim') === 'function'
    && typeof Reflect.get(value, 'confirm') === 'function'
    && typeof Reflect.get(value, 'release') === 'function';
}

function readRemainingSteps(state: EngineState): number | undefined {
  const value = state.local?.executorLocal?.remainingSteps;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`ToolNode pending user input requires ${field}`);
  }
  return value;
}

/**
 * 一批工具结算完、即将回到模型时，取走 Host 的待送达插话并写成 `user_input` 事实。
 *
 * 只在本批结果路由回 llm 时取用；Host 直接收尾、熔断、暂停或取消、
 * 以及剩余步数不够再调用一次模型时都不取，消息留给 Host 在运行结束后处理。
 * 返回的事件需随本次工具边界一起提交，提交成功后 confirm，失败则 release。
 */
export async function claimPendingUserInputs(
  state: EngineState,
  result: NodeResult,
): Promise<ClaimedPendingUserInputs | undefined> {
  if (result.kind !== 'route' || result.nextNodeId !== 'llm') return undefined;
  const local = state.local;
  const port = local?.pendingUserInputPort;
  if (!isPendingUserInputPort(port)) return undefined;
  const signal = local?.signal;
  if (signal?.aborted || isRunPauseSignal(signal)) return undefined;
  const remainingSteps = readRemainingSteps(state);
  if (remainingSteps !== undefined && remainingSteps < 1) return undefined;

  const inputs = await port.claim();
  if (inputs.length === 0) return undefined;
  const ids = inputs.map(input => input.id);
  try {
    const conversationId = readIdentity(local?.conversationId, 'conversationId');
    const turnId = readIdentity(local?.turnId, 'turnId');
    const sink = requireRuntimeEventSink(local);
    const events = inputs.map(input => sink(
      createUserInputEvent(readIdentity(input.id, 'input id'), conversationId, turnId, input.content, {
        timestamp: input.timestamp ?? Date.now(),
        delivery: 'mid_run',
      }),
      'ToolNode.pending_user_input',
    ));
    state.local = {
      ...state.local,
      history: appendWorkingHistory(parseRuntimeEvents(state.local?.history ?? []), events),
    };
    return {
      events,
      confirm: async () => { await port.confirm(ids); },
      release: async () => { await port.release(ids); },
    };
  } catch (error) {
    await port.release(ids);
    throw error;
  }
}
