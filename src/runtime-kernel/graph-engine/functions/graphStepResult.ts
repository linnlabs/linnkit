import {
  isRoutedRuntimeEvent,
  type RoutedRuntimeEvent,
  type RuntimeEvent,
} from '../../../contracts';
import type { EngineState, NodeResult } from '../types';

export type GraphStepCheckpointReset =
  | { kind: 'none'; checkpointCount: number }
  | { kind: 'applied'; checkpointCount: number }
  | { kind: 'limit_exceeded'; checkpointCount: number };

export type GraphStepAction =
  | { kind: 'route'; fromNodeId: string; nextNodeId: string }
  | { kind: 'yield' }
  | { kind: 'pause' };

export interface GraphStepResultInput {
  state: EngineState;
  result: NodeResult;
  checkpointCount: number;
  maxCheckpoints: number;
}

export interface GraphStepResultResolution {
  state: EngineState;
  events: RoutedRuntimeEvent[];
  checkpointReset: GraphStepCheckpointReset;
  shouldResetCycleStepBudget: boolean;
  action: GraphStepAction;
}

function normalizeResultEvents(events: NodeResult['events']): RoutedRuntimeEvent[] {
  if (!Array.isArray(events)) return [];
  for (const event of events) {
    const candidate: RuntimeEvent = event;
    if (!isRoutedRuntimeEvent(candidate)) {
      throw new Error(`Graph node returned an event before run admission: ${candidate.id}`);
    }
  }
  return events;
}

function assertNeverResultKind(value: never): never {
  throw new Error(`Unsupported graph node result kind: ${String(value)}`);
}

function resolveCheckpointReset(
  state: EngineState,
  checkpointCount: number,
  maxCheckpoints: number,
): Pick<GraphStepResultResolution, 'state' | 'checkpointReset' | 'shouldResetCycleStepBudget'> {
  if (state.local?._checkpointStepReset !== true) {
    return {
      state,
      checkpointReset: { kind: 'none', checkpointCount },
      shouldResetCycleStepBudget: false,
    };
  }

  // checkpoint reset 是一次性信号，必须从下一份 state 中移除，避免恢复后重复消费。
  const nextLocal = { ...state.local };
  delete nextLocal._checkpointStepReset;
  const nextCheckpointCount = checkpointCount + 1;

  if (nextCheckpointCount > maxCheckpoints) {
    return {
      state: { ...state, local: nextLocal },
      checkpointReset: { kind: 'limit_exceeded', checkpointCount: nextCheckpointCount },
      shouldResetCycleStepBudget: false,
    };
  }

  return {
    state: { ...state, local: nextLocal },
    checkpointReset: { kind: 'applied', checkpointCount: nextCheckpointCount },
    shouldResetCycleStepBudget: true,
  };
}

export function resolveGraphStepResult(input: GraphStepResultInput): GraphStepResultResolution {
  const resetResolution = resolveCheckpointReset(
    input.state,
    input.checkpointCount,
    input.maxCheckpoints,
  );

  const events = normalizeResultEvents(input.result.events);
  if (input.result.kind === 'route') {
    const nextNodeId = input.result.nextNodeId || 'user';
    return {
      ...resetResolution,
      state: { ...resetResolution.state, nodeId: nextNodeId },
      events,
      action: {
        kind: 'route',
        fromNodeId: input.state.nodeId,
        nextNodeId,
      },
    };
  }

  if (input.result.kind === 'yield') {
    return {
      ...resetResolution,
      events,
      action: { kind: 'yield' },
    };
  }

  if (input.result.kind === 'pause') {
    return {
      ...resetResolution,
      events,
      action: { kind: 'pause' },
    };
  }

  return assertNeverResultKind(input.result.kind);
}
