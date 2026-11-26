import type { ToolCatalogPort } from '../../tools/ports';
import type { RoutedRuntimeEvent, ToolCallId } from '../../../contracts';
import { Logger } from '../../../shared/logger';
import type { EngineState, NodeResult, StandardToolCall } from '../types';
import { parsePendingToolCalls } from '../functions/parsePendingToolCalls';
import {
  applyProtocolFuseState,
  createToolProtocolFuseError,
  TOOL_PROTOCOL_ERROR_FUSE_THRESHOLD,
  type ToolProtocolFuseError,
} from './toolNode.protocolFuse';
import { commitToolBoundary, createBoundaryCommitQueue, type BoundaryCommitQueue } from './toolNode.recovery';
import { isToolExecutionAbort } from './toolNode.cancellation';

const logger = new Logger('ToolNode');

/** 一组可并行调用同时执行的默认上限；Host 可在 ToolNode 装配时改，模型不能改。 */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 3;

/**
 * 从待执行清单开头取出相邻的、都声明了可并行的调用。
 *
 * 只看开头：未声明的调用是屏障，它之后的可并行调用要等它结束后另成一组，
 * 这样模型写出的先后依赖（先写后读）在混合批次里仍然成立。
 */
export function selectParallelToolGroup(
  calls: readonly StandardToolCall[],
  toolCatalog: Pick<ToolCatalogPort, 'getToolDefinition'>,
): StandardToolCall[] {
  const group: StandardToolCall[] = [];
  for (const call of calls) {
    if (toolCatalog.getToolDefinition(call.function.name)?.parallel !== true) break;
    group.push(call);
  }
  return group;
}

export type ParallelCallSettlement<T> =
  | { readonly call: StandardToolCall; readonly status: 'fulfilled'; readonly value: T }
  | { readonly call: StandardToolCall; readonly status: 'rejected'; readonly reason: unknown }
  | { readonly call: StandardToolCall; readonly status: 'not_started' };

/**
 * 按原顺序启动调用，同时在跑的不超过 limit 个，一个结束补一个。
 *
 * 一个调用失败不影响已在跑的同伴，它们照常结束；但 shouldStartNext 返回 false 后
 * （运行被停止，或已有调用抛错）不再启动新的调用，未启动的留给调用方结算。
 * 返回值与 calls 一一对应、顺序相同，与完成顺序无关。
 */
export async function runCallsWithConcurrencyLimit<T>(input: {
  readonly calls: readonly StandardToolCall[];
  readonly limit: number;
  readonly shouldStartNext: () => boolean;
  readonly run: (call: StandardToolCall) => Promise<T>;
}): Promise<ParallelCallSettlement<T>[]> {
  const settlements: ParallelCallSettlement<T>[] = input.calls.map(call => ({ call, status: 'not_started' }));
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < input.calls.length && input.shouldStartNext()) {
      const index = nextIndex;
      nextIndex += 1;
      const call = input.calls[index];
      try {
        settlements[index] = { call, status: 'fulfilled', value: await input.run(call) };
      } catch (reason) {
        settlements[index] = { call, status: 'rejected', reason };
      }
    }
  };
  const workerCount = Math.min(input.limit, input.calls.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return settlements;
}

/**
 * 并行组结束后按调用原顺序重算连续协议错误次数。
 *
 * 串行时每个调用按顺序累加或清零；并行组的结算顺序不定，若按完成顺序计数，
 * 同一批调用的熔断结果会随耗时变化。只统计已结算的调用。
 */
export function countProtocolErrorsInCallOrder(input: {
  readonly previousCount: number;
  readonly calls: readonly StandardToolCall[];
  readonly settledCallIds: ReadonlySet<ToolCallId>;
  readonly protocolErrors: ReadonlyMap<ToolCallId, string>;
}): { readonly count: number; readonly shouldFuse: boolean; readonly lastError?: string } {
  let count = input.previousCount;
  let lastError: string | undefined;
  for (const call of input.calls) {
    if (!input.settledCallIds.has(call.id)) continue;
    const error = input.protocolErrors.get(call.id);
    if (error === undefined) {
      count = 0;
      lastError = undefined;
    } else {
      count += 1;
      lastError = error;
    }
  }
  return {
    count,
    shouldFuse: lastError !== undefined && count >= TOOL_PROTOCOL_ERROR_FUSE_THRESHOLD,
    ...(lastError === undefined ? {} : { lastError }),
  };
}

/** 已结算的工具失败仍须提交结果边界，不能通过提前抛错丢弃 publisher 已接纳的事实。 */
export type ToolCallOutcome = NodeResult | {
  readonly kind: 'interrupted';
  readonly error: ToolProtocolFuseError;
  readonly events: RoutedRuntimeEvent[];
};

/**
 * 串行调用按原路径逐个结算；并行组内的调用共用组内提交队列，
 * 协议错误先记下，组结束后按调用原顺序重算熔断。
 */
export type ToolCallMode =
  | { readonly kind: 'serial' }
  | {
      readonly kind: 'parallel';
      readonly commitQueue: BoundaryCommitQueue;
      readonly protocolErrors: Map<ToolCallId, string>;
    };

export function readProtocolErrorCount(local: Record<string, unknown>): number {
  const value = local._consecutiveToolProtocolErrors;
  return typeof value === 'number' ? value : 0;
}

function firstGroupError(settlements: readonly ParallelCallSettlement<unknown>[]): unknown {
  const rejected = settlements.flatMap(item => (item.status === 'rejected' ? [item.reason] : []));
  // 暂停/取消只是停下；同组里真正的异常（如恢复受阻、Host 端口崩溃）更需要原样上报。
  return rejected.find(reason => !isToolExecutionAbort(reason)) ?? rejected[0];
}

function isAborted(state: EngineState): boolean {
  return state.local?.signal?.aborted === true;
}

/**
 * 相邻的可并行调用一起执行，同时在跑的不超过上限；结果按各自完成时间写入并提交，
 * 整组结算后才决定下一步（下一个调用、回到模型或结束），与串行批次的收口位置一致。
 */
export async function runParallelToolGroup(input: {
  readonly state: EngineState;
  readonly group: readonly StandardToolCall[];
  readonly limit: number;
  readonly conversationId: string;
  readonly turnId: string;
  /** 执行并结算单个调用（写入结果、移出待执行清单），不提交断点。 */
  readonly runCall: (call: StandardToolCall, mode: ToolCallMode) => Promise<ToolCallOutcome>;
}): Promise<ToolCallOutcome> {
  const { state, group } = input;
  const mode: ToolCallMode = {
    kind: 'parallel',
    commitQueue: createBoundaryCommitQueue(),
    protocolErrors: new Map(),
  };
  const previousProtocolErrorCount = readProtocolErrorCount(state.local ?? {});
  const events: RoutedRuntimeEvent[] = [];
  let stopLaunching = false;
  logger.info('[ToolNode] 并行执行一组工具调用', {
    conversationId: input.conversationId,
    turnId: input.turnId,
    toolCallIds: group.map(call => call.id),
    maxParallelToolCalls: input.limit,
  });

  const settlements = await runCallsWithConcurrencyLimit({
    calls: group,
    limit: input.limit,
    // 停止后或已有调用异常时不再启动新调用：未启动的由取消收口结算，或保留到继续执行。
    shouldStartNext: () => !stopLaunching && !isAborted(state),
    run: async call => {
      try {
        const outcome = await input.runCall(call, mode);
        events.push(...(outcome.events ?? []));
        // 每个调用结算后单独提交：崩溃或暂停后继续时，已完成的调用不会重跑。
        await mode.commitQueue(() => commitToolBoundary(state, { kind: 'route', nextNodeId: 'tool' }));
        return outcome;
      } catch (error) {
        stopLaunching = true;
        throw error;
      }
    },
  });

  // 同伴都已收口后再传播异常，已完成调用的结果此时都已提交。
  const groupError = firstGroupError(settlements);
  if (groupError !== undefined) {
    logger.warn('[ToolNode] 并行组中有调用未能结算，等同伴收口后上报', {
      conversationId: input.conversationId,
      turnId: input.turnId,
      rejectedToolCallIds: settlements.filter(item => item.status === 'rejected').map(item => item.call.id),
    });
    throw groupError;
  }

  const local = state.local ?? {};
  const fuse = countProtocolErrorsInCallOrder({
    previousCount: previousProtocolErrorCount,
    calls: group,
    settledCallIds: new Set(settlements.filter(item => item.status === 'fulfilled').map(item => item.call.id)),
    protocolErrors: mode.protocolErrors,
  });
  applyProtocolFuseState(local, fuse.count);
  const remainingCalls = parsePendingToolCalls(local.pendingToolCalls ?? []);
  if (fuse.shouldFuse && remainingCalls.length === 0) {
    return {
      kind: 'interrupted',
      error: createToolProtocolFuseError(fuse.count, fuse.lastError),
      events,
    };
  }
  if (remainingCalls.length === 0 && local.toolBatchCompletionMode === 'yield_after_batch') {
    return { kind: 'yield', events };
  }
  return { kind: 'route', nextNodeId: remainingCalls.length > 0 ? 'tool' : 'llm', events };
}
