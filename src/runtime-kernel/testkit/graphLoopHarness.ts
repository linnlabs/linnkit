import type { AgentInvocationRequest } from '../../ports';
import type { ExecutorLocalState, GraphNode } from '../graph-engine/types';
import type { LlmCaller } from '../llm/caller';
import type { ObservationPreviewPort, ToolExecutionContext, ToolRuntimePort } from '../tools';
import type { RuntimeEvent } from '../../contracts';
import { createDefaultGraphExecutor } from './defaultGraphExecutor';
import type { AuditPort } from '../../ports';
import type { TelemetryPort } from '../telemetry/telemetryPort';

export interface GraphLoopLlmNodeFactoryParams {
  llmCaller: LlmCaller;
  toolRuntime: ToolRuntimePort;
}

export interface GraphLoopHarnessOptions {
  conversationId: string;
  turnId: string;
  query: string;
  request: AgentInvocationRequest;
  toolContext: ToolExecutionContext;
  llmCaller: LlmCaller;
  toolRuntime: ToolRuntimePort;
  observationPreview: ObservationPreviewPort;
  createLlmNode: (params: GraphLoopLlmNodeFactoryParams) => GraphNode;
  executorLocal?: ExecutorLocalState;
  history?: RuntimeEvent[];
  maxSteps?: number;
  signal?: AbortSignal;
  auditPort?: AuditPort;
  telemetryPort?: TelemetryPort;
  sseSink?: (evt: unknown) => RuntimeEvent[] | void;
}

export interface GraphLoopHarnessRunResult {
  checkpointNodeId: string;
  stepCount: number;
}

export interface GraphLoopHarness {
  run(): Promise<GraphLoopHarnessRunResult>;
}

function buildUserInputEvent(params: {
  conversationId: string;
  turnId: string;
  query: string;
}): RuntimeEvent {
  return {
    type: 'user_input',
    id: `user_${params.turnId}`,
    conversation_id: params.conversationId,
    turn_id: params.turnId,
    timestamp: Date.now(),
    version: 1,
    content: params.query,
    source: 'user',
  };
}

export function createGraphLoopHarness(options: GraphLoopHarnessOptions): GraphLoopHarness {
  const maxSteps = options.maxSteps ?? 8;
  const executorLocal: ExecutorLocalState = {
    stepCount: 0,
    ...(options.executorLocal ?? {}),
  };

  return {
    async run(): Promise<GraphLoopHarnessRunResult> {
      const executor = createDefaultGraphExecutor({
        llmNode: options.createLlmNode({
          llmCaller: options.llmCaller,
          toolRuntime: options.toolRuntime,
        }),
        toolRuntime: options.toolRuntime,
        observationPreview: options.observationPreview,
        maxSteps,
        auditPort: options.auditPort,
        telemetryPort: options.telemetryPort,
      });

      const local = {
        conversationId: options.conversationId,
        turnId: options.turnId,
        request: options.request,
        toolContext: options.toolContext,
        history: options.history ?? [],
        newEvents: [
          buildUserInputEvent({
            conversationId: options.conversationId,
            turnId: options.turnId,
            query: options.query,
          }),
        ],
        ...(options.sseSink ? { sseSink: options.sseSink } : {}),
        signal: options.signal ?? options.toolContext.abortSignal,
        executorLocal,
      };

      await executor.prime(options.conversationId, local, 'user');
      const result = await executor.runUntilYield(options.conversationId);

      return {
        checkpointNodeId: result.checkpoint.nodeId,
        stepCount: result.stepCount,
      };
    },
  };
}
