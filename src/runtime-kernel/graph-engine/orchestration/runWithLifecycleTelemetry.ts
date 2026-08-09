import type { TelemetryPort, TelemetryScope } from '../../telemetry/telemetryPort';
import { buildRuntimeTelemetryScope, resolveRuntimeRunId } from '../functions/graphTelemetryScope';
import type { EngineState } from '../types';
import { RunIdSchema, type RunId } from '../../../contracts';

type RunLifecycleTerminalPhase = 'completed' | 'failed' | 'cancelled';

export interface RunLifecycleTaskOutput<TResult> {
  result: TResult;
  finalState: EngineState;
}

export interface RunWithLifecycleTelemetryInput<TResult> {
  checkpointKey: string;
  telemetryPort: TelemetryPort;
  loadInitialState: () => Promise<EngineState>;
  run: (initialState: EngineState) => Promise<RunLifecycleTaskOutput<TResult>>;
}

function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  return Reflect.get(error, 'name') === 'AbortError';
}

function emitRunLifecycle(
  telemetryPort: TelemetryPort,
  runId: RunId,
  phase: 'spawned' | RunLifecycleTerminalPhase,
  scope: TelemetryScope
): void {
  telemetryPort.emit({
    kind: 'run_lifecycle',
    runId,
    phase,
    scope,
  });
}

export async function runWithLifecycleTelemetry<TResult>(
  input: RunWithLifecycleTelemetryInput<TResult>
): Promise<TResult> {
  let runId = RunIdSchema.parse(input.checkpointKey);
  let initialState: EngineState;
  try {
    initialState = await input.loadInitialState();
    runId = resolveRuntimeRunId({ state: initialState, fallbackRunId: runId });
  } catch (error) {
    // 初始状态都没加载出来时，没有可信的 conversation/turn scope；空 scope 是刻意保留的故障事实。
    emitRunLifecycle(input.telemetryPort, runId, 'spawned', {});
    emitRunLifecycle(input.telemetryPort, runId, 'failed', {});
    throw error;
  }

  let lifecyclePhase: RunLifecycleTerminalPhase = 'completed';
  let lifecycleScope = buildRuntimeTelemetryScope({ state: initialState, runId });
  emitRunLifecycle(input.telemetryPort, runId, 'spawned', lifecycleScope);

  try {
    const output = await input.run(initialState);
    lifecycleScope = buildRuntimeTelemetryScope({ state: output.finalState, runId });
    return output.result;
  } catch (error) {
    lifecyclePhase = isAbortError(error) ? 'cancelled' : 'failed';
    throw error;
  } finally {
    emitRunLifecycle(input.telemetryPort, runId, lifecyclePhase, lifecycleScope);
  }
}
