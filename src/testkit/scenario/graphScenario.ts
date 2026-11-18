import {
  RunIdSchema,
  createUserInputEvent,
  type RoutedRuntimeEvent,
  type RuntimeEvent,
} from '../../contracts';
import { convertEventsToAiMessages } from '../../context-manager/profiles/agent/utils/eventConverter';
import { formatAgentLlmMessages } from '../../context-manager/shared/MessageFormatter';
import {
  GraphAgentExecutor,
  GraphExecutor,
  LlmNode,
  MemoryCheckpointer,
  MemoryEventStore,
  RunPauseRequested,
  ToolNode,
  WaitUserNode,
  createMonotonicEventStoreIdFactory,
  execution,
  isRunPauseSignal,
  parseEngineCheckpoint,
  type EngineState,
  type GraphAgentExecutorDependencies,
  type GraphExecutorContextBuilder,
  type ObservationPreviewPort,
  type PendingUserInput,
  type ToolExecutionContext,
} from '../../runtime-kernel';
import {
  createScriptedInferenceHarness,
  type ScriptedInferenceHarness,
  type ScriptedInferenceScript,
  type ScriptedLlmCall,
} from '../agent-harness/scriptedInferenceHarness';
import { createPendingUserInputQueue, type PendingUserInputQueue } from './pendingUserInputQueue';
import { routingIdentityOf } from './runtimeEventRecorder';
import {
  createScriptedToolRuntime,
  type ScriptedToolMap,
  type ScriptedToolRuntime,
} from './scriptedToolRuntime';
import {
  assertSteeringInvariants,
  type ValidateSteeringInvariantsOptions,
} from './steeringInvariants';
import { formatRuntimeTimeline, type TimelineOptions } from './timeline';

export interface GraphScenarioOptions {
  /** 脚本模型：回合表或按请求决定回合的函数。 */
  model: ScriptedInferenceScript;
  tools?: ScriptedToolMap;
  conversationId?: string;
  /**
   * 会话里已有的历史：第一次运行前就在，按 Host 读到的原样交给运行（不经过事件总线和存储）。
   * `history()` 会把它排在最前面。
   */
  history?: readonly RuntimeEvent[];
  /** 每次运行的图步数预算，默认 16。 */
  maxSteps?: number;
  /** 默认用 Agent profile 把历史转成模型消息（与插话、工具分组的真实格式一致）。 */
  contextBuilder?: GraphExecutorContextBuilder;
  observationPreview?: ObservationPreviewPort;
  tokenizer?: GraphAgentExecutorDependencies['tokenizer'];
  /** 写断点前调用；抛错即模拟存储失败。`events` 是这次边界要一起落盘的事实。 */
  beforeCheckpointWrite?: (input: {
    readonly checkpointKey: string;
    readonly events: readonly RuntimeEvent[];
  }) => void | Promise<void>;
}

export interface GraphScenarioStartInput {
  query: string;
  runId?: string;
  /** 覆盖默认请求字段（promptKey、model_id、enableTools 等）。 */
  request?: Record<string, unknown>;
}

export type GraphScenarioStatus = 'yielded' | 'awaiting_user' | 'paused' | 'cancelled' | 'failed';

export interface GraphScenarioRun {
  readonly runId: string;
  readonly status: GraphScenarioStatus;
  /** 只有 status=failed 时有值。 */
  readonly error?: unknown;
  /** 运行停下时还没送达、被 Host 收回的插话（按提交顺序）。 */
  readonly undeliveredSteers: readonly PendingUserInput[];
}

export interface GraphScenario {
  readonly conversationId: string;
  readonly model: ScriptedInferenceHarness;
  readonly tools: ScriptedToolRuntime;
  readonly steering: PendingUserInputQueue;
  /** 全部运行在实时通道上发布的事件（含流式进度）。 */
  readonly live: RoutedRuntimeEvent[];
  /** 开始一次新运行；会话里之前运行的持久历史自动带上。 */
  start(input: string | GraphScenarioStartInput): Promise<GraphScenarioRun>;
  /** 从最近一次暂停的断点继续。 */
  continue(): Promise<GraphScenarioRun>;
  /** 给当前（或下一次）运行提交插话，返回插话 id。 */
  steer(content: string, options?: { id?: string }): string;
  /** 请求暂停当前运行（下一个安全边界停下，可 `continue()`）。 */
  pause(): void;
  /** 取消当前运行。 */
  cancel(): void;
  /** 会话的持久历史：预置历史 + 事件存储里的顺序。 */
  history(): Promise<RuntimeEvent[]>;
  checkpoint(runId?: string): Promise<EngineState | null>;
  /** 持久历史的可读时间线。 */
  timeline(options?: TimelineOptions): Promise<string[]>;
  modelCalls(): ScriptedLlmCall[];
  /** 校验插话不变量与历史 id 唯一；失败时附上时间线。 */
  assertInvariants(options?: ValidateSteeringInvariantsOptions): Promise<void>;
  close(): Promise<void>;
}

interface RunContext {
  readonly runId: string;
  readonly turnId: string;
  readonly eventBus: execution.EventBus;
  readonly sink: (event: RuntimeEvent, source: string) => RoutedRuntimeEvent;
  readonly persistence: execution.EventBusEventPersistence;
  controller: AbortController;
  open: boolean;
}

const defaultContextBuilder: GraphExecutorContextBuilder = {
  async build({ history }) {
    return { llmMessages: formatAgentLlmMessages(convertEventsToAiMessages(history)) };
  },
};

const passthroughPreview: ObservationPreviewPort = {
  async truncateObservation(params) {
    return { truncated: false, preview: params.text };
  },
};

/**
 * 内存里跑真实 Graph 的场景夹具：真实的 LlmNode / GraphAgentExecutor / ToolNode / WaitUserNode、
 * 事件总线、持久化队列与断点（经过一次 JSON 序列化往返），模型和工具用脚本代替。
 *
 * 一个场景就是一段会话：可以连续开多次运行、在模型调用或工具执行的任意时刻插话、暂停、取消，
 * 最后用 `timeline()` 和 `assertInvariants()` 检查结果。
 */
export function createGraphScenario(options: GraphScenarioOptions): GraphScenario {
  const conversationId = options.conversationId ?? 'conversation';
  const model = createScriptedInferenceHarness(options.model);
  const tools = createScriptedToolRuntime(options.tools ?? {});
  const steering = createPendingUserInputQueue();
  const checkpointer = new MemoryCheckpointer();
  const eventStore = new MemoryEventStore();
  const nextEventStoreId = createMonotonicEventStoreIdFactory();
  const live: RoutedRuntimeEvent[] = [];
  const seed = [...(options.history ?? [])];
  const runs = new Map<string, RunContext>();
  let current: RunContext | undefined;
  let runCount = 0;

  const reasoner = new GraphAgentExecutor({
    llmCaller: model.getLlmCaller(),
    toolRuntime: tools,
    contextBuilder: options.contextBuilder ?? defaultContextBuilder,
    ...(options.tokenizer ? { tokenizer: options.tokenizer } : {}),
  });
  const graph = new GraphExecutor(checkpointer, {
    maxSteps: options.maxSteps ?? 16,
    executionCheckpointPort: {
      commit: (key, state) => {
        const run = runs.get(key);
        if (!run) throw new Error(`[graphScenario] 未知运行：${key}`);
        return run.persistence.commitCheckpoint(key, state);
      },
    },
  });
  graph.registerNode(new LlmNode({ reasoner }));
  graph.registerNode(new ToolNode({
    toolRuntime: tools,
    observationPreview: options.observationPreview ?? passthroughPreview,
  }));
  graph.registerNode(new WaitUserNode({}));

  function openRun(runId: string, turnId: string): RunContext {
    const sequencer = new execution.EventSequencer(conversationId);
    const eventBus = new execution.EventBus(sequencer.getExecutionId());
    eventBus.on('event', envelope => live.push(envelope.payload));
    const publisher = new execution.RuntimeEventPublisher(
      eventBus, sequencer, routingIdentityOf({ conversationId, runId }),
    );
    const persistence = new execution.EventBusEventPersistence({
      eventBus,
      eventStore,
      nextEventStoreId,
      async checkpointWriter({ checkpointKey, checkpoint, events }) {
        await options.beforeCheckpointWrite?.({ checkpointKey, events: events.map(item => item.event) });
        // Host 从 JSON 存储恢复时才解析：显式经历相同的序列化边界。
        const stored: unknown = JSON.parse(JSON.stringify(checkpoint));
        await checkpointer.save(checkpointKey, parseEngineCheckpoint(stored));
        for (const event of events) await eventStore.append(event);
      },
    });
    persistence.connect();
    const run: RunContext = {
      runId,
      turnId,
      eventBus,
      sink: (event, source) => publisher.publish(event, source),
      persistence,
      controller: new AbortController(),
      open: true,
    };
    runs.set(runId, run);
    return run;
  }

  async function closeRun(run: RunContext): Promise<void> {
    if (!run.open) return;
    run.open = false;
    run.persistence.finishCheckpointWrites();
    try {
      await run.persistence.drain();
    } finally {
      run.eventBus.close();
    }
  }

  function capabilities(run: RunContext) {
    const toolContext: ToolExecutionContext = {
      runId: RunIdSchema.parse(run.runId),
      conversationId,
      turnId: run.turnId,
      abortSignal: run.controller.signal,
    };
    return {
      signal: run.controller.signal,
      toolContext,
      runtimeEventSink: run.sink,
      pendingUserInputPort: steering.port,
    };
  }

  async function settle(run: RunContext, operation: () => Promise<EngineState>): Promise<GraphScenarioRun> {
    current = run;
    let status: GraphScenarioStatus;
    let error: unknown;
    try {
      const checkpoint = await operation();
      status = checkpoint.executionStatus === 'awaiting_user' ? 'awaiting_user' : 'yielded';
    } catch (caught) {
      const signal = run.controller.signal;
      if (signal.aborted) {
        status = isRunPauseSignal(signal) ? 'paused' : 'cancelled';
      } else {
        status = 'failed';
        error = caught;
      }
    } finally {
      current = undefined;
    }
    if (status === 'paused' || status === 'awaiting_user') {
      await run.persistence.drain().catch(() => undefined);
    } else {
      await closeRun(run).catch(caught => {
        status = 'failed';
        error ??= caught;
      });
    }
    return {
      runId: run.runId,
      status,
      ...(error !== undefined ? { error } : {}),
      undeliveredSteers: steering.drain(),
    };
  }

  async function history(): Promise<RuntimeEvent[]> {
    for (const run of runs.values()) {
      if (run.open) await run.persistence.drain().catch(() => undefined);
    }
    return [...seed, ...(await eventStore.range(conversationId)).map(item => item.event)];
  }

  let lastPaused: RunContext | undefined;

  return {
    conversationId,
    model,
    tools,
    steering,
    live,

    async start(input) {
      const { query, runId: requestedRunId, request } =
        typeof input === 'string' ? { query: input, runId: undefined, request: undefined } : input;
      runCount += 1;
      const runId = requestedRunId ?? `run_${runCount}`;
      const turnId = `turn_${runCount}`;
      const prior = await history();
      const run = openRun(runId, turnId);
      const userInput = run.sink(
        createUserInputEvent(`user_${runId}`, conversationId, turnId, query),
        'graphScenario.user_input',
      );
      const toolNames = Object.keys(options.tools ?? {});
      const outcome = await settle(run, async () => (await graph.startSession(runId, {
        ...capabilities(run),
        runId: RunIdSchema.parse(runId),
        conversationId,
        turnId,
        history: [...prior, userInput],
        request: {
          query,
          promptKey: 'agent',
          model_id: 'scripted-model',
          enableTools: toolNames.length > 0,
          availableTools: toolNames,
          ...request,
        },
      }, 'llm')).checkpoint);
      lastPaused = outcome.status === 'paused' ? run : undefined;
      return outcome;
    },

    async continue() {
      const run = lastPaused;
      if (!run) throw new Error('[graphScenario] 没有暂停中的运行可以继续');
      const saved = await checkpointer.load(run.runId);
      if (!saved?.revision) throw new Error(`[graphScenario] 运行 ${run.runId} 没有断点`);
      run.controller = new AbortController();
      const outcome = await settle(run, async () => (await graph.continueSession(run.runId, {
        expectedRevision: saved.revision ?? 0,
        capabilities: capabilities(run),
      })).checkpoint);
      lastPaused = outcome.status === 'paused' ? run : undefined;
      return outcome;
    },

    steer: (content, steerOptions) => steering.submit(content, steerOptions),

    pause() {
      if (!current) throw new Error('[graphScenario] 当前没有运行可以暂停');
      current.controller.abort(new RunPauseRequested());
    },

    cancel() {
      if (!current) throw new Error('[graphScenario] 当前没有运行可以取消');
      current.controller.abort(new Error('Run cancelled by scenario'));
    },

    history,
    checkpoint: async runId => checkpointer.load(runId ?? [...runs.keys()].at(-1) ?? ''),
    timeline: async timelineOptions => formatRuntimeTimeline(await history(), timelineOptions),
    modelCalls: () => model.getCalls(),

    async assertInvariants(invariantOptions) {
      const events = await history();
      const ids = events.map(event => event.id);
      const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
      try {
        if (duplicated.length > 0) throw new Error(`[graphScenario] 历史里有重复事件：${duplicated.join(', ')}`);
        assertSteeringInvariants({ history: events, modelCalls: model.getCalls() }, invariantOptions);
      } catch (error) {
        const timeline = formatRuntimeTimeline(events).map(line => `  ${line}`).join('\n');
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n时间线：\n${timeline}`);
      }
    },

    async close() {
      for (const run of runs.values()) await closeRun(run).catch(() => undefined);
    },
  };
}
