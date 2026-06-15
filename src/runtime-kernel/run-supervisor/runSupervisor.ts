import type { AgentSpec, EventEnvelope, RuntimeEvent } from '../../contracts';
import type { AuditPort } from '../../ports';
import { generateRunId } from '../../shared/ids';
import type { EventBus } from '../execution/event-bus';
import type { EventStore } from '../graph-engine/event-store/base';
import { DefaultRunHandle } from './runHandle';
import type {
  CancelOpts,
  RunAwaitingUserPatch,
  RunCostCollector,
  RunHandle,
  RunMeta,
  RunObserveFilter,
  RunRequestSnapshot,
} from './runHandle';
import { NotImplementedError, RunAlreadyRegisteredError, RunNotFoundError } from './runErrors';
import type { ListRunsFilter, RunRecord, RunRegistryStore } from './runRegistryStorePort';

export type RunTerminalStatus = Extract<RunRecord['status'], 'completed' | 'failed' | 'cancelled'>;

export type RunTerminalError = {
  errorCode: string;
  message: string;
  recoverable: boolean;
};

export interface RunOutcome {
  runId: string;
  status: RunTerminalStatus;
  completedAt: number;
  currentNode?: string;
  iterationsUsed?: number;
  error?: RunTerminalError;
  metadata?: Record<string, unknown>;
}

export interface RunSnapshot extends RunMeta {
  metadata?: Record<string, unknown>;
}

export interface RunTerminalEvent {
  runId: string;
  status: RunTerminalStatus;
  outcome: RunOutcome;
}

export interface RunWaitForTerminalOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FindActiveByConversationOptions {
  includeChildren?: boolean;
  agentSpecId?: string;
}

export interface RunExecutionContext<TRequest extends RunRequestSnapshot = RunRequestSnapshot> {
  runId: string;
  parentRunId?: string;
  conversationId: string;
  agentSpec: AgentSpec;
  request: TRequest;
  signal: AbortSignal;
  eventBus: EventBus;
  eventStore: EventStore;
  costCollector: RunCostCollector;
  query?: string;
  contextFences?: readonly unknown[];
  wakeSource?: string;
  ephemeral?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RunExecutorPort<TRequest extends RunRequestSnapshot = RunRequestSnapshot> {
  execute(context: RunExecutionContext<TRequest>): Promise<RunOutcome | void>;
}

export interface RunRegistrationSpec<TRequest extends RunRequestSnapshot = RunRequestSnapshot> {
  runId?: string;
  parentRunId?: string;
  parentSignal?: AbortSignal;
  conversationId: string;
  agentSpec: AgentSpec;
  request: TRequest;
  eventBus: EventBus;
  eventStore: EventStore;
  costCollector: RunCostCollector;
  iterationBudget?: RunRecord['iterationBudget'];
  query?: string;
  contextFences?: readonly unknown[];
  wakeSource?: string;
  ephemeral?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RunSupervisor<TRequest extends RunRequestSnapshot = RunRequestSnapshot> {
  registerRun(spec: RunRegistrationSpec<TRequest>): Promise<RunHandle<TRequest>>;
  spawnDetached(spec: RunRegistrationSpec<TRequest>): Promise<RunHandle<TRequest>>;
  observeRun(runId: string, filter?: RunObserveFilter): AsyncIterable<RuntimeEvent>;
  cancel(runId: string, opts: CancelOpts): Promise<void>;
  markAwaitingUser(runId: string, patch?: RunAwaitingUserPatch): Promise<void>;
  list(filter?: ListRunsFilter): Promise<{ runs: RunMeta[]; nextCursor?: string }>;
  peek(runId: string): Promise<RunMeta | null>;
  waitForTerminal(runId: string, opts?: RunWaitForTerminalOptions): Promise<RunOutcome>;
  findActiveByConversation(
    conversationId: string,
    opts?: FindActiveByConversationOptions,
  ): Promise<RunSnapshot[]>;
  drain(opts?: RunWaitForTerminalOptions): Promise<RunOutcome[]>;
  recoverOnBoot(reason?: string): Promise<RunOutcome[]>;
  pause(runId: string, reason?: string): Promise<never>;
  resume(runId: string): Promise<never>;
  runTree(rootRunId: string): Promise<never>;
  handleFailure(runId: string, error: unknown): Promise<never>;
}

export interface DefaultRunSupervisorOptions<TRequest extends RunRequestSnapshot = RunRequestSnapshot> {
  registryStore: RunRegistryStore;
  auditPort?: AuditPort;
  executor?: RunExecutorPort<TRequest>;
  runIdFactory?: () => string;
  now?: () => number;
}

type TerminalWaiter = {
  resolve: (outcome: RunOutcome) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readRunIdFromRuntimeEvent(event: RuntimeEvent): string | undefined {
  const metadata = event.metadata;
  if (!metadata) {
    return undefined;
  }

  const directRunId = readStringField(metadata, 'runId') ?? readStringField(metadata, 'run_id');
  if (directRunId) {
    return directRunId;
  }

  const runContext = metadata['run_context'];
  if (!isRecord(runContext)) {
    return undefined;
  }

  return readStringField(runContext, 'runId') ?? readStringField(runContext, 'run_id');
}

function readAwaitingUserReason(event: RuntimeEvent): string | undefined {
  if (event.type !== 'requires_user_interaction') {
    return undefined;
  }

  if (typeof event.prompt === 'string' && event.prompt.trim().length > 0) {
    return event.prompt;
  }

  if (isRecord(event.form)) {
    const prompt = readStringField(event.form, 'prompt');
    if (prompt && prompt.trim().length > 0) {
      return prompt;
    }
  }

  return undefined;
}

function isTerminalStatus(status: RunRecord['status']): status is RunTerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isActiveStatus(status: RunRecord['status']): boolean {
  return status === 'pending' || status === 'running' || status === 'awaiting_user' || status === 'paused';
}

function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return metadata ? structuredClone(metadata) : undefined;
}

function recordToSnapshot(record: RunRecord): RunSnapshot {
  return {
    runId: record.runId,
    parentRunId: record.parentRunId,
    agentSpecId: record.agentSpecId,
    conversationId: record.conversationId,
    status: record.status,
    currentNode: record.currentNode,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    pausedAt: record.pausedAt,
    pauseReason: record.pauseReason,
    iterationsUsed: record.iterationsUsed,
    errorIfAny: record.errorIfAny ? { ...record.errorIfAny } : undefined,
    metadata: cloneMetadata(record.metadata),
  };
}

function recordToTerminalOutcome(record: RunRecord, completedAt: number): RunOutcome {
  return {
    runId: record.runId,
    status: isTerminalStatus(record.status) ? record.status : 'failed',
    completedAt,
    currentNode: record.currentNode,
    iterationsUsed: record.iterationsUsed,
    error: record.errorIfAny ? { ...record.errorIfAny } : undefined,
    metadata: cloneMetadata(record.metadata),
  };
}

function errorToTerminalError(error: unknown): RunTerminalError {
  if (error instanceof Error) {
    return {
      errorCode: error.name === 'AbortError' ? 'RUN_CANCELLED' : 'RUN_FAILED',
      message: error.message,
      recoverable: false,
    };
  }
  return {
    errorCode: 'RUN_FAILED',
    message: String(error),
    recoverable: false,
  };
}

export class DefaultRunSupervisor<TRequest extends RunRequestSnapshot = RunRequestSnapshot>
  implements RunSupervisor<TRequest>
{
  private readonly registryStore: RunRegistryStore;
  private readonly auditPort?: AuditPort;
  private readonly executor?: RunExecutorPort<TRequest>;
  private readonly runIdFactory: () => string;
  private readonly now: () => number;
  private readonly handles = new Map<string, RunHandle<TRequest>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly inFlight = new Map<string, Promise<RunOutcome>>();
  private readonly terminalOutcomes = new Map<string, RunOutcome>();
  private readonly terminalWaiters = new Map<string, Set<TerminalWaiter>>();

  constructor(options: DefaultRunSupervisorOptions<TRequest>) {
    this.registryStore = options.registryStore;
    this.auditPort = options.auditPort;
    this.executor = options.executor;
    this.runIdFactory = options.runIdFactory ?? generateRunId;
    this.now = options.now ?? (() => Date.now());
  }

  async registerRun(spec: RunRegistrationSpec<TRequest>): Promise<RunHandle<TRequest>> {
    const runId = spec.runId ?? this.runIdFactory();
    if (this.handles.has(runId) || (await this.registryStore.load(runId))) {
      throw new RunAlreadyRegisteredError(runId);
    }

    const startedAt = this.now();
    const controller = new AbortController();
    if (spec.parentSignal) {
      if (spec.parentSignal.aborted) {
        controller.abort(spec.parentSignal.reason);
      } else {
        spec.parentSignal.addEventListener('abort', () => {
          controller.abort(spec.parentSignal?.reason);
        }, { once: true });
      }
    }

    const record: RunRecord = {
      runId,
      conversationId: spec.conversationId,
      parentRunId: spec.parentRunId,
      agentSpecId: spec.agentSpec.id,
      status: 'pending',
      startedAt,
      updatedAt: startedAt,
      iterationBudget: spec.iterationBudget ? { ...spec.iterationBudget } : undefined,
      metadata: cloneMetadata(spec.metadata),
    };

    await this.registryStore.save(record);

    const handle = new DefaultRunHandle<TRequest>({
      runRecord: record,
      abortController: controller,
      agentSpec: spec.agentSpec,
      request: spec.request,
      eventBus: spec.eventBus,
      eventStore: spec.eventStore,
      costCollector: spec.costCollector,
      registryStore: this.registryStore,
      auditPort: this.auditPort,
      onCancelled: (cancelledRunId) => {
        this.handles.delete(cancelledRunId);
        this.controllers.delete(cancelledRunId);
        void this.registryStore.load(cancelledRunId).then((cancelledRecord) => {
          if (cancelledRecord?.status === 'cancelled') {
            this.notifyTerminalWaiters(recordToTerminalOutcome(cancelledRecord, this.now()));
          }
        });
      },
    });

    this.handles.set(runId, handle);
    this.controllers.set(runId, controller);
    this.watchAwaitingUserEvents(spec.eventBus, handle);
    return handle;
  }

  async spawnDetached(spec: RunRegistrationSpec<TRequest>): Promise<RunHandle<TRequest>> {
    if (!this.executor) {
      throw new NotImplementedError('RunSupervisor.spawnDetached requires a RunExecutorPort');
    }

    const handle = await this.registerRun(spec);
    const execution = this.executeDetachedRun(handle, spec);
    this.inFlight.set(handle.runId, execution);
    void execution.finally(() => {
      this.inFlight.delete(handle.runId);
    });
    return handle;
  }

  async *observeRun(runId: string, filter?: RunObserveFilter): AsyncIterable<RuntimeEvent> {
    const handle = this.getHandle(runId);
    yield* handle.observe(filter);
  }

  async cancel(runId: string, opts: CancelOpts): Promise<void> {
    await this.getHandle(runId).cancel(opts);
    const record = await this.registryStore.load(runId);
    if (record?.status === 'cancelled') {
      this.notifyTerminalWaiters(recordToTerminalOutcome(record, this.now()));
    }
  }

  async markAwaitingUser(runId: string, patch: RunAwaitingUserPatch = {}): Promise<void> {
    await this.getHandle(runId).markAwaitingUser(patch);
  }

  async list(filter?: ListRunsFilter): Promise<{ runs: RunMeta[]; nextCursor?: string }> {
    const result = await this.registryStore.list(filter);
    return {
      runs: result.runs.map((record) => this.toRunMeta(record)),
      nextCursor: result.nextCursor,
    };
  }

  async peek(runId: string): Promise<RunMeta | null> {
    const record = await this.registryStore.load(runId);
    return record ? this.toRunMeta(record) : null;
  }

  async waitForTerminal(runId: string, opts: RunWaitForTerminalOptions = {}): Promise<RunOutcome> {
    const cachedOutcome = this.terminalOutcomes.get(runId);
    if (cachedOutcome) {
      return { ...cachedOutcome, metadata: cloneMetadata(cachedOutcome.metadata) };
    }

    const record = await this.registryStore.load(runId);
    if (!record) {
      throw new RunNotFoundError(runId);
    }
    if (isTerminalStatus(record.status)) {
      return recordToTerminalOutcome(record, this.now());
    }

    return new Promise<RunOutcome>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const waiters = this.getTerminalWaiters(runId);
      const waiter: TerminalWaiter = {
        resolve: (outcome) => {
          waiter.cleanup();
          resolve({ ...outcome, metadata: cloneMetadata(outcome.metadata) });
        },
        reject: (error) => {
          waiter.cleanup();
          reject(error);
        },
        cleanup: () => {
          waiters.delete(waiter);
          if (timeout) {
            clearTimeout(timeout);
          }
          opts.signal?.removeEventListener('abort', onAbort);
        },
      };
      const onAbort = (): void => {
        waiter.reject(new Error(`waitForTerminal aborted for run ${runId}`));
      };
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          waiter.reject(new Error(`waitForTerminal timed out for run ${runId}`));
        }, opts.timeoutMs);
      }
      waiters.add(waiter);
    });
  }

  async findActiveByConversation(
    conversationId: string,
    opts: FindActiveByConversationOptions = {},
  ): Promise<RunSnapshot[]> {
    const result = await this.registryStore.list({
      status: ['pending', 'running', 'awaiting_user', 'paused'],
      agentSpecId: opts.agentSpecId,
    });
    return result.runs
      .filter((record) => record.conversationId === conversationId)
      .filter((record) => opts.includeChildren === true || record.parentRunId === undefined)
      .map(recordToSnapshot);
  }

  async drain(opts: RunWaitForTerminalOptions = {}): Promise<RunOutcome[]> {
    const runIds = Array.from(this.inFlight.keys());
    return Promise.all(runIds.map((runId) => this.waitForTerminal(runId, opts)));
  }

  async recoverOnBoot(reason = 'process restarted before run reached terminal status'): Promise<RunOutcome[]> {
    const result = await this.registryStore.list({
      status: ['pending', 'running', 'awaiting_user', 'paused'],
    });
    const outcomes: RunOutcome[] = [];
    for (const record of result.runs) {
      const updatedAt = this.now();
      const nextRecord: RunRecord = {
        ...record,
        status: 'failed',
        updatedAt,
        errorIfAny: {
          errorCode: 'RUN_ABANDONED',
          message: reason,
          recoverable: true,
        },
        metadata: {
          ...(record.metadata ?? {}),
          recovery: {
            reason,
            recoveredAt: updatedAt,
          },
        },
      };
      await this.registryStore.save(nextRecord);
      const outcome = recordToTerminalOutcome(nextRecord, updatedAt);
      this.terminalOutcomes.set(record.runId, outcome);
      this.notifyTerminalWaiters(outcome);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  async pause(_runId: string, _reason?: string): Promise<never> {
    throw new NotImplementedError('RunSupervisor.pause is N-3.B; not implemented in N-3.A');
  }

  async resume(_runId: string): Promise<never> {
    throw new NotImplementedError('RunSupervisor.resume is N-3.B; not implemented in N-3.A');
  }

  async runTree(_rootRunId: string): Promise<never> {
    throw new NotImplementedError('RunSupervisor.runTree is N-3.B; not implemented in N-3.A');
  }

  async handleFailure(_runId: string, _error: unknown): Promise<never> {
    throw new NotImplementedError('RunSupervisor.handleFailure is N-3.B; not implemented in N-3.A');
  }

  private async executeDetachedRun(
    handle: RunHandle<TRequest>,
    spec: RunRegistrationSpec<TRequest>,
  ): Promise<RunOutcome> {
    if (!this.executor) {
      throw new NotImplementedError('RunSupervisor.spawnDetached requires a RunExecutorPort');
    }

    try {
      await handle.markRunning({ currentNode: 'detached' });
      const registeredRecord = await this.registryStore.load(handle.runId);
      const executorOutcome = await this.executor.execute({
        runId: handle.runId,
        parentRunId: handle.parentRunId,
        conversationId: registeredRecord?.conversationId ?? spec.conversationId,
        agentSpec: await handle.spec(),
        request: await handle.request(),
        signal: handle.signal,
        eventBus: spec.eventBus,
        eventStore: spec.eventStore,
        costCollector: spec.costCollector,
        query: spec.query,
        contextFences: spec.contextFences,
        wakeSource: spec.wakeSource,
        ephemeral: spec.ephemeral,
        metadata: cloneMetadata(registeredRecord?.metadata ?? spec.metadata),
      });
      const outcome = await this.persistExecutorOutcome(handle, executorOutcome);
      this.notifyTerminalWaiters(outcome);
      return outcome;
    } catch (error) {
      const terminalError = errorToTerminalError(error);
      if (terminalError.errorCode === 'RUN_CANCELLED' || handle.signal.aborted) {
        await handle.cancel({
          reason: terminalError.message || 'detached run aborted',
          forceCleanup: true,
        });
      } else {
        await handle.markFailed(terminalError);
      }
      const record = await this.registryStore.load(handle.runId);
      const outcome = recordToTerminalOutcome(record ?? {
        runId: handle.runId,
        parentRunId: handle.parentRunId,
        conversationId: spec.conversationId,
        agentSpecId: spec.agentSpec.id,
        status: terminalError.errorCode === 'RUN_CANCELLED' ? 'cancelled' : 'failed',
        startedAt: this.now(),
        updatedAt: this.now(),
        errorIfAny: terminalError,
      }, this.now());
      this.terminalOutcomes.set(handle.runId, outcome);
      this.notifyTerminalWaiters(outcome);
      return outcome;
    }
  }

  private async persistExecutorOutcome(
    handle: RunHandle<TRequest>,
    executorOutcome: RunOutcome | void,
  ): Promise<RunOutcome> {
    if (!executorOutcome || executorOutcome.status === 'completed') {
      await handle.markCompleted({
        currentNode: executorOutcome?.currentNode,
        iterationsUsed: executorOutcome?.iterationsUsed,
      });
    } else if (executorOutcome.status === 'cancelled') {
      await handle.cancel({
        reason: executorOutcome.error?.message ?? 'detached run cancelled',
        forceCleanup: true,
      });
    } else {
      await handle.markFailed(executorOutcome.error ?? {
        errorCode: 'RUN_FAILED',
        message: 'detached run failed',
        recoverable: false,
      }, {
        currentNode: executorOutcome.currentNode,
        iterationsUsed: executorOutcome.iterationsUsed,
      });
    }

    const loadedRecord = await this.registryStore.load(handle.runId);
    const record = loadedRecord && executorOutcome?.metadata
      ? {
          ...loadedRecord,
          metadata: {
            ...(loadedRecord.metadata ?? {}),
            ...executorOutcome.metadata,
          },
        }
      : loadedRecord;
    if (record && executorOutcome?.metadata) {
      await this.registryStore.save(record);
    }
    const completedAt = executorOutcome?.completedAt ?? this.now();
    const fallbackMeta = record ? undefined : await handle.meta();
    const outcome = recordToTerminalOutcome(record ?? {
      runId: handle.runId,
      parentRunId: handle.parentRunId,
      conversationId: fallbackMeta?.conversationId ?? '',
      agentSpecId: fallbackMeta?.agentSpecId,
      status: executorOutcome?.status ?? 'completed',
      startedAt: fallbackMeta?.startedAt ?? completedAt,
      updatedAt: completedAt,
    }, completedAt);
    const nextOutcome: RunOutcome = {
      ...outcome,
      metadata: {
        ...(outcome.metadata ?? {}),
        ...(executorOutcome?.metadata ?? {}),
      },
    };
    this.terminalOutcomes.set(handle.runId, nextOutcome);
    return nextOutcome;
  }

  private getTerminalWaiters(runId: string): Set<TerminalWaiter> {
    const waiters = this.terminalWaiters.get(runId);
    if (waiters) {
      return waiters;
    }
    const created = new Set<TerminalWaiter>();
    this.terminalWaiters.set(runId, created);
    return created;
  }

  private notifyTerminalWaiters(outcome: RunOutcome): void {
    this.terminalOutcomes.set(outcome.runId, outcome);
    const waiters = this.terminalWaiters.get(outcome.runId);
    if (!waiters) {
      return;
    }
    for (const waiter of Array.from(waiters)) {
      waiter.resolve(outcome);
    }
    this.terminalWaiters.delete(outcome.runId);
  }

  private getHandle(runId: string): RunHandle<TRequest> {
    const handle = this.handles.get(runId);
    if (!handle) {
      throw new RunNotFoundError(runId);
    }
    return handle;
  }

  private watchAwaitingUserEvents(eventBus: EventBus, handle: RunHandle<TRequest>): void {
    const onEvent = (envelope: EventEnvelope<RuntimeEvent>): void => {
      const event = envelope.payload;
      if (event.type !== 'requires_user_interaction') {
        return;
      }

      const eventRunId = readRunIdFromRuntimeEvent(event);
      if (eventRunId !== handle.runId) {
        return;
      }

      // EventBus 是同步通知模型；生命周期写入异步执行，避免阻塞事件分发链路。
      void handle.markAwaitingUser({
        currentNode: 'wait_user',
        eventId: event.id,
        reason: readAwaitingUserReason(event),
      }).catch((error: unknown) => {
        console.warn('[RunSupervisor] failed to mark awaiting_user from requires_user_interaction', error);
      });
    };
    const onClose = (): void => {
      eventBus.off('event', onEvent);
      eventBus.off('close', onClose);
    };

    eventBus.on('event', onEvent);
    eventBus.on('close', onClose);
  }

  private toRunMeta(record: RunRecord): RunMeta {
    return {
      runId: record.runId,
      parentRunId: record.parentRunId,
      agentSpecId: record.agentSpecId,
      conversationId: record.conversationId,
      status: record.status,
      currentNode: record.currentNode,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      pausedAt: record.pausedAt,
      pauseReason: record.pauseReason,
      iterationsUsed: record.iterationsUsed,
      errorIfAny: record.errorIfAny ? { ...record.errorIfAny } : undefined,
    };
  }
}
