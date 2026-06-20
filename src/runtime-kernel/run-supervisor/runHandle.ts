import { AgentSpec as AgentSpecSchema } from '../../contracts';
import type { AgentSpec, EventEnvelope, RunTokenUsageAggregate, RuntimeEvent } from '../../contracts';
import type { AuditPort } from '../../ports';
import { generateAuditEnvelopeId } from '../../shared/ids';
import type { EventBus } from '../execution/event-bus';
import type { EventStore, PersistedEvent } from '../graph-engine/event-store/base';
import { createEventStoreAudit } from '../audit/eventStoreAudit';
import { NotImplementedError } from './runErrors';
import type { RunRecord, RunRegistryStore, RunStatus } from './runRegistryStorePort';

export type RunRequestSnapshot = Readonly<object>;

export interface CancelOpts {
  reason: string;
  forceCleanup?: boolean;
  timeout?: number;
}

export interface RunCost {
  tokensInput: number;
  tokensOutput: number;
  tokenUsage?: RunTokenUsageAggregate;
  tokenLedgerEntryIds?: string[];
  totalCostUsd?: number;
  latencyMs?: number;
  childrenTotal?: RunCost;
}

export interface RunCostCollector {
  snapshot(runId: string): RunCost | Promise<RunCost>;
}

export interface RunLifecyclePatch {
  currentNode?: string;
  iterationsUsed?: number;
}

export interface RunAwaitingUserPatch extends RunLifecyclePatch {
  reason?: string;
  eventId?: string;
}

export interface RunFailureInfo {
  errorCode: string;
  message: string;
  recoverable: boolean;
}

export interface RunMeta {
  runId: string;
  parentRunId?: string;
  agentSpecId?: string;
  conversationId: string;
  status: RunStatus;
  currentNode?: string;
  startedAt: number;
  updatedAt: number;
  pausedAt?: number;
  pauseReason?: string;
  iterationsUsed?: number;
  errorIfAny?: { errorCode: string; message: string; recoverable: boolean };
}

export interface RunObserveFilter {
  /** RuntimeEvent 使用 type 作为主判别字段；保留 kinds 只是为了贴近 N-3 草案措辞。 */
  types?: RuntimeEvent['type'][];
  kinds?: RuntimeEvent['type'][];
  includePersisted?: boolean;
}

export interface RunHandle<TRequest extends RunRequestSnapshot = RunRequestSnapshot> {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly signal: AbortSignal;
  spec(): Promise<AgentSpec>;
  request(): Promise<TRequest>;
  cancel(opts: CancelOpts): Promise<void>;
  observe(filter?: RunObserveFilter): AsyncIterable<RuntimeEvent>;
  cost(): Promise<RunCost>;
  meta(): Promise<RunMeta>;
  markRunning(patch?: RunLifecyclePatch): Promise<void>;
  markAwaitingUser(patch?: RunAwaitingUserPatch): Promise<void>;
  markCompleted(patch?: RunLifecyclePatch): Promise<void>;
  markFailed(error: RunFailureInfo, patch?: RunLifecyclePatch): Promise<void>;
  pause(reason?: string): Promise<never>;
  resume(): Promise<never>;
}

export interface DefaultRunHandleOptions<TRequest extends RunRequestSnapshot = RunRequestSnapshot> {
  runRecord: RunRecord;
  abortController: AbortController;
  agentSpec: AgentSpec;
  request: TRequest;
  eventBus: EventBus;
  eventStore: EventStore;
  costCollector: RunCostCollector;
  registryStore: RunRegistryStore;
  auditPort?: AuditPort;
  onCancelled?: (runId: string, opts: CancelOpts) => void;
}

type EventQueueState = {
  queue: RuntimeEvent[];
  closed: boolean;
  error: Error | null;
  wake: (() => void) | null;
};

function cloneRequest<TRequest extends RunRequestSnapshot>(request: TRequest): TRequest {
  return structuredClone(request);
}

function cloneRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  return structuredClone(event);
}

function runRecordToMeta(record: RunRecord): RunMeta {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function getRunIdFromMetadata(event: RuntimeEvent): string | undefined {
  const metadata = event.metadata;
  if (!metadata) {
    return undefined;
  }

  const camelCaseRunId = readStringField(metadata, 'runId');
  if (camelCaseRunId) {
    return camelCaseRunId;
  }

  const snakeCaseRunId = readStringField(metadata, 'run_id');
  if (snakeCaseRunId) {
    return snakeCaseRunId;
  }

  // 有些 host 会把 run id 写进 metadata.run_context.runId；persisted replay 必须识别这个真实形状。
  const runContext = metadata['run_context'];
  if (isRecord(runContext)) {
    return readStringField(runContext, 'runId') ?? readStringField(runContext, 'run_id');
  }

  return undefined;
}

function matchesPersistedRunId(runId: string, event: PersistedEvent): boolean {
  return event.runId === runId || getRunIdFromMetadata(event.event) === runId;
}

function matchesEventType(event: RuntimeEvent, filter?: RunObserveFilter): boolean {
  const selectedTypes = filter?.types ?? filter?.kinds;
  return selectedTypes === undefined || selectedTypes.includes(event.type);
}

async function waitForEventQueue(state: EventQueueState): Promise<void> {
  await new Promise<void>((resolve) => {
    state.wake = resolve;
  });
  state.wake = null;
}

/**
 * RunHandle 的默认实现只编织现有机制：
 * - cancel 只触发 AbortController，不改 GraphExecutor；
 * - observe 只包装 EventBus/EventStore；
 * - cost 只读取外部注入的 CostCollector。
 */
export class DefaultRunHandle<TRequest extends RunRequestSnapshot = RunRequestSnapshot>
  implements RunHandle<TRequest>
{
  readonly runId: string;
  readonly parentRunId?: string;
  readonly signal: AbortSignal;

  private runRecord: RunRecord;
  private readonly abortController: AbortController;
  private readonly agentSpecSnapshot: AgentSpec;
  private readonly requestSnapshot: TRequest;
  private readonly eventBus: EventBus;
  private readonly eventStore: EventStore;
  private readonly costCollector: RunCostCollector;
  private readonly registryStore: RunRegistryStore;
  private readonly auditPort: AuditPort;
  private readonly onCancelled?: (runId: string, opts: CancelOpts) => void;

  constructor(options: DefaultRunHandleOptions<TRequest>) {
    this.runRecord = { ...options.runRecord };
    this.runId = options.runRecord.runId;
    this.parentRunId = options.runRecord.parentRunId;
    this.abortController = options.abortController;
    this.signal = options.abortController.signal;
    this.agentSpecSnapshot = AgentSpecSchema.parse(structuredClone(options.agentSpec));
    this.requestSnapshot = cloneRequest(options.request);
    this.eventBus = options.eventBus;
    this.eventStore = options.eventStore;
    this.costCollector = options.costCollector;
    this.registryStore = options.registryStore;
    this.auditPort = options.auditPort ?? createEventStoreAudit({ eventStore: options.eventStore });
    this.onCancelled = options.onCancelled;
  }

  async spec(): Promise<AgentSpec> {
    return AgentSpecSchema.parse(structuredClone(this.agentSpecSnapshot));
  }

  async request(): Promise<TRequest> {
    return cloneRequest(this.requestSnapshot);
  }

  async cancel(opts: CancelOpts): Promise<void> {
    this.abortController.abort(opts.reason);

    const latestRecord = await this.registryStore.load(this.runId);
    const nextRecord: RunRecord = {
      ...(latestRecord ?? this.runRecord),
      status: 'cancelled',
      updatedAt: Date.now(),
      errorIfAny: {
        errorCode: 'RUN_CANCELLED',
        message: opts.reason,
        recoverable: false,
      },
      metadata: {
        ...((latestRecord ?? this.runRecord).metadata ?? {}),
        cancel: {
          reason: opts.reason,
          forceCleanup: opts.forceCleanup ?? false,
          timeout: opts.timeout,
        },
      },
    };

    await this.registryStore.save(nextRecord);
    this.runRecord = { ...nextRecord };
    await this.auditPort.emit({
      envelopeId: generateAuditEnvelopeId(),
      runId: this.runId,
      parentRunId: this.parentRunId,
      ts: Date.now(),
      actor: { kind: 'host' },
      action: 'run.cancel',
      decision: {
        outcome: 'cancelled',
        reason: opts.reason,
        metadata: {
          forceCleanup: opts.forceCleanup ?? false,
          ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
        },
      },
      evidence: [
        {
          kind: 'cancel_request',
          summary: opts.reason,
        },
      ],
      scope: {
        conversationId: nextRecord.conversationId,
        runId: this.runId,
        parentRunId: this.parentRunId,
        agentSpecId: nextRecord.agentSpecId,
      },
    });
    this.onCancelled?.(this.runId, opts);
  }

  async *observe(filter: RunObserveFilter = {}): AsyncIterable<RuntimeEvent> {
    if (filter.includePersisted) {
      const persistedEvents = await this.eventStore.range(this.runRecord.conversationId);
      for (const persistedEvent of persistedEvents) {
        if (matchesPersistedRunId(this.runId, persistedEvent) && matchesEventType(persistedEvent.event, filter)) {
          yield cloneRuntimeEvent(persistedEvent.event);
        }
      }
    }

    const state: EventQueueState = {
      queue: [],
      closed: false,
      error: null,
      wake: null,
    };

    const wake = (): void => {
      state.wake?.();
    };
    const onEvent = (envelope: EventEnvelope<RuntimeEvent>): void => {
      if (matchesEventType(envelope.payload, filter)) {
        state.queue.push(cloneRuntimeEvent(envelope.payload));
        wake();
      }
    };
    const onError = (error: Error): void => {
      state.error = error;
      wake();
    };
    const onClose = (): void => {
      state.closed = true;
      wake();
    };

    this.eventBus.on('event', onEvent);
    this.eventBus.on('error', onError);
    this.eventBus.on('close', onClose);

    try {
      while (!state.closed || state.queue.length > 0) {
        if (state.error) {
          throw state.error;
        }
        const nextEvent = state.queue.shift();
        if (nextEvent) {
          yield nextEvent;
          continue;
        }
        await waitForEventQueue(state);
      }
    } finally {
      this.eventBus.off('event', onEvent);
      this.eventBus.off('error', onError);
      this.eventBus.off('close', onClose);
    }
  }

  async cost(): Promise<RunCost> {
    return this.costCollector.snapshot(this.runId);
  }

  async meta(): Promise<RunMeta> {
    const latestRecord = await this.registryStore.load(this.runId);
    if (latestRecord) {
      this.runRecord = { ...latestRecord };
    }
    return runRecordToMeta(latestRecord ?? this.runRecord);
  }

  async markRunning(patch: RunLifecyclePatch = {}): Promise<void> {
    await this.saveLifecycleStatus('running', patch);
  }

  async markAwaitingUser(patch: RunAwaitingUserPatch = {}): Promise<void> {
    await this.saveLifecycleStatus('awaiting_user', patch);
  }

  async markCompleted(patch: RunLifecyclePatch = {}): Promise<void> {
    await this.saveLifecycleStatus('completed', patch);
  }

  async markFailed(error: RunFailureInfo, patch: RunLifecyclePatch = {}): Promise<void> {
    await this.saveLifecycleStatus('failed', patch, error);
  }

  async pause(_reason?: string): Promise<never> {
    throw new NotImplementedError('RunHandle.pause is N-3.B; not implemented in N-3.A');
  }

  async resume(): Promise<never> {
    throw new NotImplementedError('RunHandle.resume is N-3.B; not implemented in N-3.A');
  }

  private async saveLifecycleStatus(
    status: Extract<RunStatus, 'running' | 'awaiting_user' | 'completed' | 'failed'>,
    patch: RunLifecyclePatch | RunAwaitingUserPatch,
    errorIfAny?: RunFailureInfo,
  ): Promise<void> {
    const latestRecord = await this.registryStore.load(this.runId);
    const baseRecord = latestRecord ?? this.runRecord;
    const awaitingUserPatch = status === 'awaiting_user' ? patch as RunAwaitingUserPatch : undefined;
    const updatedAt = Date.now();
    const nextRecord: RunRecord = {
      ...baseRecord,
      status,
      updatedAt,
      currentNode: patch.currentNode ?? baseRecord.currentNode,
      iterationsUsed: patch.iterationsUsed ?? baseRecord.iterationsUsed,
      pauseReason: status === 'awaiting_user' ? awaitingUserPatch?.reason ?? baseRecord.pauseReason : undefined,
      pausedAt: status === 'awaiting_user' ? updatedAt : undefined,
      errorIfAny,
      metadata: awaitingUserPatch?.eventId
        ? {
            ...(baseRecord.metadata ?? {}),
            awaitingUser: {
              eventId: awaitingUserPatch.eventId,
              reason: awaitingUserPatch.reason,
            },
          }
        : baseRecord.metadata,
    };

    await this.registryStore.save(nextRecord);
    this.runRecord = { ...nextRecord };
  }
}

export function runMetaFromRecord(record: RunRecord): RunMeta {
  return runRecordToMeta(record);
}
