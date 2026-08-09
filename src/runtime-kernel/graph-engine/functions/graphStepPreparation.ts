import { ENGINE_STATE_SCHEMA_VERSION, type EngineState, type ExecutorLocalState } from '../types';
import { decideLlmInvocationState } from './llmInvocationState';

export type FinalStepPolicy = NonNullable<ExecutorLocalState['finalStepPolicy']>;

export interface GraphStepPreparationInput {
  state: EngineState;
  maxSteps: number;
  cycleStepCount: number;
  checkpointCount: number;
}

export interface GraphStepPreparationResult {
  state: EngineState;
  executorLocal: Record<string, unknown>;
  forcedToLlm: boolean;
  forceReason?: string;
  fromNodeId?: string;
}

function readExecutorLocal(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function resolveFinalStepPolicy(value: unknown): FinalStepPolicy {
  return value === 'force_tools' || value === 'final_answer' ? value : 'final_answer';
}

export function prepareGraphStep(input: GraphStepPreparationInput): GraphStepPreparationResult {
  const isLastStep = input.cycleStepCount >= input.maxSteps;
  const rawLocal = input.state.local && typeof input.state.local === 'object' ? input.state.local : {};
  const localForStep: Record<string, unknown> = { ...(rawLocal as Record<string, unknown>) };

  const executorLocalForStep = readExecutorLocal(localForStep.executorLocal);
  executorLocalForStep.maxSteps = input.maxSteps;
  executorLocalForStep.stepCount = input.cycleStepCount;
  executorLocalForStep.remainingSteps = input.maxSteps - input.cycleStepCount;
  executorLocalForStep.checkpointCount = input.checkpointCount;

  const finalStepPolicy = resolveFinalStepPolicy(executorLocalForStep.finalStepPolicy);
  const isPenultimateStep = input.cycleStepCount === input.maxSteps - 1;
  if (finalStepPolicy === 'force_tools') {
    executorLocalForStep.phase = isPenultimateStep
      ? 'force_tools'
      : (executorLocalForStep.phase ?? 'running');
  } else {
    executorLocalForStep.phase = isLastStep ? 'force_final_answer' : (executorLocalForStep.phase ?? 'running');
  }
  localForStep.executorLocal = executorLocalForStep;

  const shouldForceToLlm =
    finalStepPolicy === 'force_tools'
      ? isPenultimateStep
      : isLastStep;

  let nextState: EngineState = {
    ...input.state,
    schemaVersion: input.state.schemaVersion ?? ENGINE_STATE_SCHEMA_VERSION,
    local: localForStep,
  };
  let forcedToLlm = false;
  let forceReason: string | undefined;
  let fromNodeId: string | undefined;

  if (shouldForceToLlm && input.state.nodeId !== 'wait_user' && input.state.nodeId !== 'answer') {
    delete localForStep.pendingToolCalls;
    delete localForStep.pendingInteractionSpec;
    delete localForStep.lastToolResult;
    if (input.state.nodeId !== 'llm') {
      forceReason =
        finalStepPolicy === 'force_tools'
          ? 'force tools before maxSteps'
          : 'force final answer at maxSteps';
      fromNodeId = input.state.nodeId;
      forcedToLlm = true;
      nextState = { ...input.state, schemaVersion: nextState.schemaVersion, nodeId: 'llm', local: localForStep };
    }
  }

  const invocationState = decideLlmInvocationState({
    nodeId: nextState.nodeId,
    previousInvocationCount: executorLocalForStep.llmInvocationCount,
  });
  if (invocationState) {
    executorLocalForStep.llmInvocationKind = invocationState.llmInvocationKind;
    executorLocalForStep.llmInvocationCount = invocationState.llmInvocationCount;
    localForStep.executorLocal = executorLocalForStep;
    nextState = { ...nextState, local: localForStep };
  }

  return {
    state: nextState,
    executorLocal: executorLocalForStep,
    forcedToLlm,
    forceReason,
    fromNodeId,
  };
}
