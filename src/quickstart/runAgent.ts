import {
  createFinalAnswerChunkEvent,
  createUserInputEvent,
  type RuntimeEvent,
} from '../contracts';
import { generateMessageId, generateRunId } from '../shared/ids';
import {
  GraphAgentExecutor,
  LlmCaller,
  LlmNode,
  MemoryCheckpointer,
  type ObservationPreviewPort,
  type ToolExecutionContext,
  createDefaultGraphExecutor,
  execution,
  graph,
  runSupervisor,
} from '../runtime-kernel';
import type { DefinedAgent, RunAgentOptions, RunAgentResult } from './types';
import { QuickstartContextBuilder } from './contextBuilder';
import { QuickstartMemoryToolRuntime } from './toolRuntime';
import {
  QuickstartRunCostCollector,
  createQuickstartTelemetryPort,
} from './runCost';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function resolveModelId(agent: DefinedAgent, options: RunAgentOptions): string {
  const modelId = readString(options.modelId) ?? readString(agent.modelId);
  if (!modelId) {
    throw new Error('[linnkit] runAgent requires modelId. Pass opts.modelId or defineAgent({ modelId }).');
  }
  return modelId;
}

interface QuickstartStreamChunkEvent {
  type: 'stream_chunk';
  content: string;
  answer_id?: string;
  seq?: number;
}

function isQuickstartStreamChunkEvent(value: unknown): value is QuickstartStreamChunkEvent {
  return isRecord(value) && value.type === 'stream_chunk' && typeof value.content === 'string';
}

function createNoopObservationPreview(): ObservationPreviewPort {
  return {
    async truncateObservation(params) {
      return { truncated: false, preview: params.text };
    },
  };
}

function buildChunkRuntimeEvent(params: {
  event: QuickstartStreamChunkEvent;
  conversationId: string;
  turnId: string;
}): RuntimeEvent[] {
  const content = params.event.content;
  if (!content) return [];
  const answerId = readString(params.event.answer_id) ?? `answer_${params.turnId}`;
  const seq = Number.isInteger(params.event.seq) ? Number(params.event.seq) : 0;
  return [
    createFinalAnswerChunkEvent(
      generateMessageId(),
      params.conversationId,
      params.turnId,
      answerId,
      seq,
      content,
      {
        ephemeral: true,
        metadata: {
          run_context: { runId: params.turnId },
        },
      },
    ),
  ];
}

function readFinalAnswer(events: RuntimeEvent[], checkpointLocal: unknown): string {
  const finalAnswerEvent = [...events].reverse().find((event) => event.type === 'final_answer');
  if (finalAnswerEvent?.type === 'final_answer') {
    return finalAnswerEvent.content;
  }

  const chunks = events
    .filter((event): event is Extract<RuntimeEvent, { type: 'final_answer_chunk' }> =>
      event.type === 'final_answer_chunk')
    .sort((a, b) => a.seq - b.seq)
    .map((event) => event.content);
  if (chunks.length > 0) {
    return chunks.join('');
  }

  if (isRecord(checkpointLocal)) {
    const finalAnswer = checkpointLocal['finalAnswer'];
    if (typeof finalAnswer === 'string') {
      return finalAnswer;
    }
  }

  return '';
}

function readContextTrace(checkpointLocal: unknown): unknown {
  if (!isRecord(checkpointLocal)) return undefined;
  return checkpointLocal['contextTrace'];
}

async function emitRunEvent(
  event: RuntimeEvent,
  sink: RunAgentOptions['onEvent'],
): Promise<void> {
  await sink?.(event);
}

/**
 * 运行一个 quickstart agent。
 *
 * 中文备注：
 * - 这个 helper 用于“npm install 后立即跑通”的最小体验；
 * - 生产 host 仍应自行装配 EventStore / ToolRuntime / ContextManager / RunSupervisor。
 */
export async function runAgent(
  agent: DefinedAgent,
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const modelId = resolveModelId(agent, options);
  const conversationId = options.conversationId ?? `conv_${Date.now()}`;
  const checkpointKey = conversationId;
  const runId = options.runId ?? generateRunId();
  const turnId = runId;
  const costCollector = new QuickstartRunCostCollector();
  const telemetryPort = createQuickstartTelemetryPort(costCollector);
  const toolRuntime = new QuickstartMemoryToolRuntime(agent.tools);
  const eventStore = new graph.MemoryEventStore();
  const eventBus = new execution.EventBus(`exec_${runId}`);
  const registryStore = new runSupervisor.MemoryRunRegistryStore();
  const supervisor = new runSupervisor.DefaultRunSupervisor({
    registryStore,
  });

  const handle = await supervisor.registerRun({
    runId,
    parentSignal: options.signal,
    conversationId,
    agentSpec: agent.spec,
    request: { query: options.input, promptKey: agent.spec.id, model_id: modelId },
    eventBus,
    eventStore,
    costCollector,
  });

  const llmCaller = new LlmCaller({
    aiEngine: options.llm,
    maxRetries: 0,
    enableEmptyResponseRetry: false,
  });
  const reasoner = new GraphAgentExecutor({
    llmCaller,
    toolRuntime,
    contextBuilder: new QuickstartContextBuilder(agent),
    telemetryPort,
  });
  const executor = createDefaultGraphExecutor({
    llmNode: new LlmNode({ reasoner }),
    toolRuntime,
    observationPreview: createNoopObservationPreview(),
    checkpointer: new MemoryCheckpointer(),
    telemetryPort,
    maxSteps: 8,
  });

  const runtimeEvents: RuntimeEvent[] = [
    createUserInputEvent(generateMessageId(), conversationId, turnId, options.input, {
      metadata: { run_context: { runId } },
    }),
  ];
  await emitRunEvent(runtimeEvents[0], options.onEvent);
  const toolContext: ToolExecutionContext = {
    runId,
    conversationId,
    turnId,
    abortSignal: handle.signal,
  };

  await handle.markRunning({ currentNode: 'user' });
  try {
    await executor.prime(checkpointKey, {
      conversationId,
      turnId,
      request: {
        query: options.input,
        promptKey: agent.spec.id,
        model_id: modelId,
        enableTools: agent.tools.length > 0,
        availableTools: agent.tools.map((tool) => tool.name),
      },
      history: [],
      newEvents: runtimeEvents,
      toolContext,
      signal: handle.signal,
      sseSink: (event: unknown) => {
        if (isQuickstartStreamChunkEvent(event)) {
          const chunkEvents = buildChunkRuntimeEvent({ event, conversationId, turnId });
          for (const chunkEvent of chunkEvents) {
            void emitRunEvent(chunkEvent, options.onEvent);
          }
          return chunkEvents;
        }
        return undefined;
      },
    });
    const result = await executor.runUntilYield(checkpointKey);
    runtimeEvents.push(...result.events);
    for (const event of result.events) {
      if (event.type === 'final_answer_chunk') continue;
      await emitRunEvent(event, options.onEvent);
    }
    for (const event of runtimeEvents) {
      await eventStore.append(conversationId, {
        eventId: event.id,
        timestamp: event.timestamp,
        conversationId,
        runId,
        event,
      });
    }
    await handle.markCompleted({ currentNode: result.checkpoint.nodeId, iterationsUsed: result.stepCount });
    return {
      runId,
      finalAnswer: readFinalAnswer(runtimeEvents, result.checkpoint.local),
      events: runtimeEvents,
      cost: await handle.cost(),
      contextTrace: readContextTrace(result.checkpoint.local),
    };
  } catch (error) {
    await handle.markFailed({
      errorCode: 'RUN_FAILED',
      message: error instanceof Error ? error.message : String(error),
      recoverable: false,
    });
    throw error;
  } finally {
    eventBus.close();
  }
}
