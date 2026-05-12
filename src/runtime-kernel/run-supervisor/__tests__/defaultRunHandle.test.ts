import { describe, expect, it, vi } from 'vitest';

import type { AgentSpec, EventEnvelope, RuntimeEvent } from '../../../contracts';
import type { AuditPort } from '../../../ports';
import { EventBus } from '../../execution/event-bus';
import { MemoryEventStore } from '../../graph-engine/event-store/memoryEventStore';
import { MemoryRunRegistryStore } from '../memoryRunRegistryStore';
import { DefaultRunHandle } from '../runHandle';
import type { CancelOpts, RunCostCollector, RunRequestSnapshot } from '../runHandle';
import { NotImplementedError } from '../runErrors';
import type { RunRecord } from '../runRegistryStorePort';

const agentSpec: AgentSpec = {
  id: 'deep_research_leader',
  version: '1.0.0',
  capabilities: ['research'],
  tools: [{ toolId: 'search' }],
  contextPolicy: { profileId: 'agent' },
};

const request = {
  query: '研究 N-3',
  promptKey: 'deep_research_leader',
} satisfies RunRequestSnapshot;

function createRuntimeEvent(id: string, content: string): RuntimeEvent {
  return {
    type: 'thought',
    id,
    conversation_id: 'conv-1',
    turn_id: 'turn-1',
    timestamp: 100,
    version: 1,
    content,
    is_complete: false,
  };
}

function wrapEvent(event: RuntimeEvent, seq: number): EventEnvelope<RuntimeEvent> {
  return {
    seq,
    timestamp: event.timestamp,
    trace: { execution_id: 'exec-1' },
    source: 'test',
    payload: event,
  };
}

async function collectEvents(iterable: AsyncIterable<RuntimeEvent>, count: number): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    if (events.length >= count) {
      break;
    }
  }
  return events;
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    agentSpecId: agentSpec.id,
    status: 'running',
    startedAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

async function createHandle(options: { auditPort?: AuditPort } = {}) {
  const registryStore = new MemoryRunRegistryStore();
  const eventBus = new EventBus('exec-1');
  const eventStore = new MemoryEventStore();
  const abortController = new AbortController();
  const costCollector: RunCostCollector = {
    snapshot: vi.fn(() => ({
      tokensInput: 100,
      tokensOutput: 50,
      totalCostUsd: 0.0015,
      latencyMs: 20,
    })),
  };
  const runRecord = createRunRecord();
  await registryStore.save(runRecord);

  const onCancelled = vi.fn<(runId: string, opts: CancelOpts) => void>();
  const handle = new DefaultRunHandle({
    runRecord,
    abortController,
    agentSpec,
    request,
    eventBus,
    eventStore,
    costCollector,
    registryStore,
    auditPort: options.auditPort,
    onCancelled,
  });

  return {
    handle,
    registryStore,
    eventBus,
    eventStore,
    abortController,
    costCollector,
    onCancelled,
  };
}

describe('DefaultRunHandle', () => {
  it('只暴露用于 GraphExecutor 装配的只读 AbortSignal', async () => {
    const { handle, abortController } = await createHandle();

    expect(handle.signal).toBe(abortController.signal);
    expect(handle.signal.aborted).toBe(false);
  });

  it('cancel 写入 cancelled RunRecord，并触发 AbortController 与 onCancelled', async () => {
    const { handle, registryStore, abortController, onCancelled } = await createHandle();

    await handle.cancel({ reason: '用户取消', forceCleanup: false });

    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe('用户取消');
    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      status: 'cancelled',
      errorIfAny: {
        errorCode: 'RUN_CANCELLED',
        message: '用户取消',
        recoverable: false,
      },
    });
    expect(onCancelled).toHaveBeenCalledWith('run-1', { reason: '用户取消', forceCleanup: false });
  });

  it('cancel 发出标准 AuditEnvelope', async () => {
    const emit = vi.fn<AuditPort['emit']>();
    const { handle } = await createHandle({ auditPort: { emit } });

    await handle.cancel({ reason: '用户取消', forceCleanup: true, timeout: 50 });

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      action: 'run.cancel',
      actor: { kind: 'host' },
      decision: expect.objectContaining({
        outcome: 'cancelled',
        reason: '用户取消',
        metadata: {
          forceCleanup: true,
          timeout: 50,
        },
      }),
      scope: expect.objectContaining({
        conversationId: 'conv-1',
        runId: 'run-1',
        agentSpecId: 'deep_research_leader',
      }),
    }));
  });

  it('observe 能收到 EventBus 的实时 RuntimeEvent', async () => {
    const { handle, eventBus } = await createHandle();
    const collectPromise = collectEvents(handle.observe(), 2);

    await nextTask();
    eventBus.publish(wrapEvent(createRuntimeEvent('evt-1', '第一条'), 1));
    eventBus.publish(wrapEvent(createRuntimeEvent('evt-2', '第二条'), 2));

    await expect(collectPromise).resolves.toEqual([
      createRuntimeEvent('evt-1', '第一条'),
      createRuntimeEvent('evt-2', '第二条'),
    ]);
  });

  it('observe(includePersisted=true) 先回放持久化事件，再接实时事件', async () => {
    const { handle, eventBus, eventStore } = await createHandle();
    await eventStore.append('conv-1', {
      eventId: 'p-1',
      timestamp: 1,
      conversationId: 'conv-1',
      runId: 'run-1',
      event: createRuntimeEvent('evt-p1', '历史一'),
    });
    await eventStore.append('conv-1', {
      eventId: 'p-2',
      timestamp: 2,
      conversationId: 'conv-1',
      runId: 'run-other',
      event: createRuntimeEvent('evt-other', '别的 run'),
    });
    await eventStore.append('conv-1', {
      eventId: 'p-3',
      timestamp: 3,
      conversationId: 'conv-1',
      runId: 'run-1',
      event: createRuntimeEvent('evt-p2', '历史二'),
    });
    await eventStore.append('conv-1', {
      eventId: 'p-4',
      timestamp: 4,
      conversationId: 'conv-1',
      runId: 'legacy-turn-id',
      event: {
        ...createRuntimeEvent('evt-p3', '嵌套 run_context 历史'),
        metadata: {
          run_context: {
            runId: 'run-1',
          },
        },
      },
    });

    const collectPromise = collectEvents(handle.observe({ includePersisted: true }), 4);

    await nextTask();
    eventBus.publish(wrapEvent(createRuntimeEvent('evt-live', '实时'), 1));

    await expect(collectPromise).resolves.toEqual([
      createRuntimeEvent('evt-p1', '历史一'),
      createRuntimeEvent('evt-p2', '历史二'),
      {
        ...createRuntimeEvent('evt-p3', '嵌套 run_context 历史'),
        metadata: {
          run_context: {
            runId: 'run-1',
          },
        },
      },
      createRuntimeEvent('evt-live', '实时'),
    ]);
  });

  it('cost 返回 CostCollector 的快照', async () => {
    const { handle, costCollector } = await createHandle();

    await expect(handle.cost()).resolves.toEqual({
      tokensInput: 100,
      tokensOutput: 50,
      totalCostUsd: 0.0015,
      latencyMs: 20,
    });
    expect(costCollector.snapshot).toHaveBeenCalledWith('run-1');
  });

  it('markRunning/markCompleted/markFailed 写入 RunRecord 生命周期状态', async () => {
    const { handle, registryStore } = await createHandle();

    await handle.markRunning({ currentNode: 'llm' });
    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      status: 'running',
      currentNode: 'llm',
    });

    await handle.markAwaitingUser({
      currentNode: 'wait_user',
      iterationsUsed: 2,
      eventId: 'wait-event-1',
      reason: '需要用户确认',
    });
    const awaitingRecord = await registryStore.load('run-1');
    expect(awaitingRecord).toMatchObject({
      status: 'awaiting_user',
      currentNode: 'wait_user',
      iterationsUsed: 2,
      pauseReason: '需要用户确认',
      metadata: {
        awaitingUser: {
          eventId: 'wait-event-1',
          reason: '需要用户确认',
        },
      },
    });
    expect(awaitingRecord?.pausedAt).toEqual(expect.any(Number));

    await handle.markRunning({ currentNode: 'llm' });
    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      status: 'running',
      currentNode: 'llm',
      pausedAt: undefined,
      pauseReason: undefined,
    });

    await handle.markCompleted({ currentNode: 'answer', iterationsUsed: 4 });
    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      status: 'completed',
      currentNode: 'answer',
      iterationsUsed: 4,
      errorIfAny: undefined,
    });

    await handle.markFailed({
      errorCode: 'LLM_ERROR',
      message: '模型请求失败',
      recoverable: true,
    });
    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      status: 'failed',
      errorIfAny: {
        errorCode: 'LLM_ERROR',
        message: '模型请求失败',
        recoverable: true,
      },
    });
  });

  it('spec/request getter 返回注册时的快照，不受外部对象后续修改影响', async () => {
    const mutableSpec: AgentSpec = structuredClone(agentSpec);
    const mutableRequest = { query: '原始问题', promptKey: 'default' } satisfies RunRequestSnapshot;
    const registryStore = new MemoryRunRegistryStore();
    const runRecord = createRunRecord();
    await registryStore.save(runRecord);
    const handle = new DefaultRunHandle({
      runRecord,
      abortController: new AbortController(),
      agentSpec: mutableSpec,
      request: mutableRequest,
      eventBus: new EventBus('exec-1'),
      eventStore: new MemoryEventStore(),
      costCollector: { snapshot: () => ({ tokensInput: 0, tokensOutput: 0 }) },
      registryStore,
    });

    mutableSpec.id = 'changed';
    mutableRequest.query = '修改后的问题';

    await expect(handle.spec()).resolves.toMatchObject({ id: 'deep_research_leader' });
    await expect(handle.request()).resolves.toEqual({ query: '原始问题', promptKey: 'default' });
  });

  it('pause/resume 在 N-3.A 段明确抛 NotImplementedError', async () => {
    const { handle } = await createHandle();

    await expect(handle.pause('稍后继续')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(handle.resume()).rejects.toBeInstanceOf(NotImplementedError);
  });
});
