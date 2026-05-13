import { describe, expect, it, vi } from 'vitest';

import type { AgentSpec, EventEnvelope, RuntimeEvent } from '../../../contracts';
import { EventBus } from '../../execution/event-bus';
import { MemoryEventStore } from '../../graph-engine/event-store/memoryEventStore';
import { DefaultRunSupervisor } from '../runSupervisor';
import type { RunCostCollector, RunRequestSnapshot } from '../runHandle';
import type { RunExecutorPort, RunOutcome } from '../runSupervisor';
import { NotImplementedError, RunAlreadyRegisteredError, RunNotFoundError } from '../runErrors';
import { MemoryRunRegistryStore } from '../memoryRunRegistryStore';

const agentSpec: AgentSpec = {
  id: 'default_agent',
  version: '1.0.0',
  capabilities: ['chat'],
  tools: [],
  contextPolicy: { profileId: 'agent' },
};

const request = {
  query: '继续',
  promptKey: 'default',
} satisfies RunRequestSnapshot;

function createRuntimeEvent(id: string): RuntimeEvent {
  return {
    type: 'thought',
    id,
    conversation_id: 'conv-1',
    turn_id: 'turn-1',
    timestamp: 100,
    version: 1,
    content: id,
    is_complete: false,
  };
}

function createWaitUserEvent(runId: string): RuntimeEvent {
  return {
    type: 'requires_user_interaction',
    id: 'wait-1',
    conversation_id: 'conv-1',
    turn_id: 'turn-1',
    timestamp: 101,
    version: 1,
    form: {
      prompt: '需要用户确认',
    },
    metadata: {
      run_context: {
        runId,
      },
    },
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

function createCostCollector(): RunCostCollector {
  return {
    snapshot: () => ({ tokensInput: 7, tokensOutput: 3 }),
  };
}

async function registerOneRun() {
  const registryStore = new MemoryRunRegistryStore();
  const supervisor = new DefaultRunSupervisor({
    registryStore,
    runIdFactory: () => 'run-1',
    now: () => 10,
  });
  const eventBus = new EventBus('exec-1');
  const eventStore = new MemoryEventStore();
  const handle = await supervisor.registerRun({
    conversationId: 'conv-1',
    parentRunId: 'parent-1',
    agentSpec,
    request,
    eventBus,
    eventStore,
    costCollector: createCostCollector(),
    metadata: {
      executionId: 'exec-1',
      turnId: 'turn-1',
    },
  });

  return { registryStore, supervisor, eventBus, handle };
}

describe('DefaultRunSupervisor', () => {
  it('registerRun 生成 runId、写 pending RunRecord，并返回 handle', async () => {
    const { registryStore, handle } = await registerOneRun();

    expect(handle.runId).toBe('run-1');
    expect(handle.parentRunId).toBe('parent-1');
    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      conversationId: 'conv-1',
      parentRunId: 'parent-1',
      agentSpecId: 'default_agent',
      status: 'pending',
      startedAt: 10,
      updatedAt: 10,
      metadata: {
        executionId: 'exec-1',
        turnId: 'turn-1',
      },
    });
  });

  it('显式传入 runId 时 RunRecord.runId 与传入值相等', async () => {
    const registryStore = new MemoryRunRegistryStore();
    const supervisor = new DefaultRunSupervisor({
      registryStore,
      runIdFactory: () => 'generated-run',
      now: () => 10,
    });

    const handle = await supervisor.registerRun({
      runId: 'turn_abc',
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-1'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    });

    expect(handle.runId).toBe('turn_abc');
    await expect(registryStore.load('turn_abc')).resolves.toMatchObject({
      runId: 'turn_abc',
      conversationId: 'conv-1',
      agentSpecId: 'default_agent',
      status: 'pending',
    });
  });

  it('同 runId 注册 2 次抛 RunAlreadyRegisteredError，第一次 handle 仍可用', async () => {
    const { supervisor, handle } = await registerOneRun();

    await expect(supervisor.registerRun({
      runId: 'run-1',
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-duplicate'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    })).rejects.toBeInstanceOf(RunAlreadyRegisteredError);

    await expect(handle.meta()).resolves.toMatchObject({
      runId: 'run-1',
      status: 'pending',
    });
  });

  it('parentSignal abort 时 runHandle.signal 级联 abort', async () => {
    const registryStore = new MemoryRunRegistryStore();
    const parentController = new AbortController();
    const supervisor = new DefaultRunSupervisor({ registryStore });

    const handle = await supervisor.registerRun({
      runId: 'turn_abc',
      parentSignal: parentController.signal,
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-1'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    });

    parentController.abort('parent reason');

    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe('parent reason');
  });

  it('peek 能读取 RunMeta', async () => {
    const { supervisor } = await registerOneRun();

    await expect(supervisor.peek('run-1')).resolves.toMatchObject({
      runId: 'run-1',
      parentRunId: 'parent-1',
      agentSpecId: 'default_agent',
      status: 'pending',
    });
  });

  it('list 能按 RunRegistryStore 过滤并返回 RunMeta', async () => {
    const { supervisor } = await registerOneRun();

    await expect(supervisor.list({ agentSpecId: 'default_agent' })).resolves.toMatchObject({
      runs: [
        {
          runId: 'run-1',
          agentSpecId: 'default_agent',
          status: 'pending',
        },
      ],
    });
  });

  it('cancel 通过 handle 取消 run 并写 cancelled 状态', async () => {
    const { registryStore, supervisor } = await registerOneRun();

    await supervisor.cancel('run-1', { reason: '用户取消', forceCleanup: true });

    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      status: 'cancelled',
      errorIfAny: {
        errorCode: 'RUN_CANCELLED',
        message: '用户取消',
      },
      metadata: {
        cancel: {
          reason: '用户取消',
          forceCleanup: true,
        },
      },
    });
  });

  it('直接调用 handle.cancel 也会唤醒 waitForTerminal', async () => {
    const { supervisor, handle } = await registerOneRun();
    const waitPromise = supervisor.waitForTerminal('run-1');

    await handle.cancel({ reason: '直接取消' });

    await expect(waitPromise).resolves.toMatchObject({
      runId: 'run-1',
      status: 'cancelled',
      error: {
        errorCode: 'RUN_CANCELLED',
        message: '直接取消',
        recoverable: false,
      },
    });
  });

  it('markAwaitingUser 写入 awaiting_user 状态', async () => {
    const { registryStore, supervisor } = await registerOneRun();

    await supervisor.markAwaitingUser('run-1', {
      currentNode: 'wait_user',
      eventId: 'wait-1',
      reason: '需要用户确认',
    });

    const record = await registryStore.load('run-1');
    expect(record).toMatchObject({
      status: 'awaiting_user',
      currentNode: 'wait_user',
      pauseReason: '需要用户确认',
      metadata: {
        awaitingUser: {
          eventId: 'wait-1',
          reason: '需要用户确认',
        },
      },
    });
    expect(record?.pausedAt).toEqual(expect.any(Number));
  });

  it('requires_user_interaction 事件会联动 RunRecord.status=awaiting_user', async () => {
    const { registryStore, eventBus } = await registerOneRun();

    eventBus.publish(wrapEvent(createWaitUserEvent('run-1'), 1));
    await nextTask();

    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      status: 'awaiting_user',
      currentNode: 'wait_user',
      pauseReason: '需要用户确认',
      metadata: {
        awaitingUser: {
          eventId: 'wait-1',
          reason: '需要用户确认',
        },
      },
    });
  });

  it('observeRun 能委托给对应 handle 的实时事件流', async () => {
    const { supervisor, eventBus } = await registerOneRun();
    const collectPromise = collectEvents(supervisor.observeRun('run-1'), 1);

    await nextTask();
    eventBus.publish(wrapEvent(createRuntimeEvent('evt-1'), 1));

    await expect(collectPromise).resolves.toEqual([createRuntimeEvent('evt-1')]);
  });

  it('不存在的 runId 在 observe/cancel 时抛 RunNotFoundError', async () => {
    const { supervisor } = await registerOneRun();

    await expect(supervisor.cancel('missing-run', { reason: '不存在' })).rejects.toBeInstanceOf(RunNotFoundError);
    const iterator = supervisor.observeRun('missing-run')[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it('N-3.B 方法明确抛 NotImplementedError', async () => {
    const { supervisor } = await registerOneRun();

    await expect(supervisor.pause('run-1', '稍后')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(supervisor.resume('run-1')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(supervisor.runTree('run-1')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(new DefaultRunSupervisor({ registryStore: new MemoryRunRegistryStore() }).spawnDetached({
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-detached'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    })).rejects.toBeInstanceOf(NotImplementedError);
    await expect(supervisor.handleFailure('run-1', new Error('boom'))).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('spawnDetached 通过 RunExecutorPort 执行并写入 completed 终态', async () => {
    const registryStore = new MemoryRunRegistryStore();
    const execute = vi.fn<RunExecutorPort['execute']>(async (context) => ({
      runId: context.runId,
      status: 'completed',
      completedAt: 20,
      currentNode: 'answer',
      iterationsUsed: 3,
      metadata: {
        source: 'executor',
      },
    }));
    const supervisor = new DefaultRunSupervisor({
      registryStore,
      executor: { execute },
      runIdFactory: () => 'detached-1',
      now: () => 10,
    });

    const handle = await supervisor.spawnDetached({
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-detached'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
      iterationBudget: { max: 8, refundable: true },
      query: '后台跑',
      wakeSource: 'test',
      metadata: { traceId: 'trace-1' },
    });
    const outcome = await supervisor.waitForTerminal(handle.runId);

    expect(handle.runId).toBe('detached-1');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'detached-1',
      conversationId: 'conv-1',
      query: '后台跑',
      wakeSource: 'test',
      metadata: { traceId: 'trace-1' },
    }));
    expect(outcome).toMatchObject({
      runId: 'detached-1',
      status: 'completed',
      currentNode: 'answer',
      iterationsUsed: 3,
      metadata: {
        traceId: 'trace-1',
        source: 'executor',
      },
    });
    await expect(registryStore.load('detached-1')).resolves.toMatchObject({
      status: 'completed',
      currentNode: 'answer',
      iterationsUsed: 3,
      iterationBudget: { max: 8, refundable: true },
      metadata: {
        traceId: 'trace-1',
        source: 'executor',
      },
    });
  });

  it('waitForTerminal 不会漏掉稍后完成的 detached run', async () => {
    const registryStore = new MemoryRunRegistryStore();
    let resolveOutcome: ((outcome: RunOutcome) => void) | undefined;
    const outcomePromise = new Promise<RunOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const supervisor = new DefaultRunSupervisor({
      registryStore,
      executor: { execute: () => outcomePromise },
      runIdFactory: () => 'detached-wait',
      now: () => 30,
    });

    const handle = await supervisor.spawnDetached({
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-wait'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    });
    const waitPromise = supervisor.waitForTerminal(handle.runId);

    resolveOutcome?.({
      runId: handle.runId,
      status: 'completed',
      completedAt: 40,
      currentNode: 'answer',
    });

    await expect(waitPromise).resolves.toMatchObject({
      runId: 'detached-wait',
      status: 'completed',
      currentNode: 'answer',
    });
  });

  it('findActiveByConversation 只返回指定会话的活跃顶层 run', async () => {
    const registryStore = new MemoryRunRegistryStore();
    const supervisor = new DefaultRunSupervisor({ registryStore });
    await supervisor.registerRun({
      runId: 'root-active',
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-root'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    });
    await supervisor.registerRun({
      runId: 'child-active',
      parentRunId: 'root-active',
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-child'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    });
    await supervisor.registerRun({
      runId: 'other-conv',
      conversationId: 'conv-2',
      agentSpec,
      request,
      eventBus: new EventBus('exec-other'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    });

    await expect(supervisor.findActiveByConversation('conv-1')).resolves.toEqual([
      expect.objectContaining({ runId: 'root-active', conversationId: 'conv-1' }),
    ]);
    const activeRunsWithChildren = await supervisor.findActiveByConversation('conv-1', { includeChildren: true });
    expect(activeRunsWithChildren.map((run) => run.runId).sort()).toEqual(['child-active', 'root-active']);
    for (const run of activeRunsWithChildren) {
      expect(run.conversationId).toBe('conv-1');
    }
  });

  it('recoverOnBoot 把非终态 run 标记为 RUN_ABANDONED', async () => {
    const { registryStore, supervisor } = await registerOneRun();
    await supervisor.markAwaitingUser('run-1', { currentNode: 'wait_user', reason: '等待用户' });

    const outcomes = await supervisor.recoverOnBoot('进程重启');

    expect(outcomes).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        status: 'failed',
        error: {
          errorCode: 'RUN_ABANDONED',
          message: '进程重启',
          recoverable: true,
        },
      }),
    ]);
    await expect(registryStore.load('run-1')).resolves.toMatchObject({
      status: 'failed',
      errorIfAny: {
        errorCode: 'RUN_ABANDONED',
        message: '进程重启',
        recoverable: true,
      },
    });
  });

  it('drain 等待所有 in-flight detached run 进入终态', async () => {
    const registryStore = new MemoryRunRegistryStore();
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const executor: RunExecutorPort = {
      async execute(context) {
        await new Promise<void>((resolve) => {
          if (context.runId === 'run-a') {
            releaseFirst = resolve;
          } else {
            releaseSecond = resolve;
          }
        });
        return {
          runId: context.runId,
          status: 'completed',
          completedAt: 50,
        };
      },
    };
    let idCounter = 0;
    const supervisor = new DefaultRunSupervisor({
      registryStore,
      executor,
      runIdFactory: () => (idCounter++ === 0 ? 'run-a' : 'run-b'),
      now: () => 50,
    });

    await supervisor.spawnDetached({
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-a'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    });
    await supervisor.spawnDetached({
      conversationId: 'conv-1',
      agentSpec,
      request,
      eventBus: new EventBus('exec-b'),
      eventStore: new MemoryEventStore(),
      costCollector: createCostCollector(),
    });
    const drainPromise = supervisor.drain();

    await nextTask();
    releaseFirst?.();
    releaseSecond?.();

    await expect(drainPromise).resolves.toEqual([
      expect.objectContaining({ runId: 'run-a', status: 'completed' }),
      expect.objectContaining({ runId: 'run-b', status: 'completed' }),
    ]);
  });
});
