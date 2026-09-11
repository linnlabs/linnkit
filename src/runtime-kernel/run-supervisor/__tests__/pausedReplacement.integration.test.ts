import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionIdSchema, RunIdSchema, type AgentSpec } from '../../../contracts';
import { EventBus } from '../../execution/event-bus';
import { MemoryEventStore } from '../../graph-engine/event-store/memoryEventStore';
import { DefaultRunSupervisor } from '../runSupervisor';
import { MemoryRunRegistryStore } from '../memoryRunRegistryStore';
import type { RunRegistrationSpec } from '../definitions/runSupervisorContracts';

const agentSpec: AgentSpec = {
  id: 'agent', version: '1', capabilities: ['chat'], tools: [], contextPolicy: { profileId: 'agent' },
};
function registration(runId: string, executionId: string): RunRegistrationSpec {
  return {
    runId: RunIdSchema.parse(runId), conversationId: 'conversation', concurrencyKey: 'foreground',
    agentSpec, request: { query: runId }, eventBus: new EventBus(ExecutionIdSchema.parse(executionId)),
    eventStore: new MemoryEventStore(), costCollector: { snapshot: () => ({ tokensInput: 0, tokensOutput: 0 }) },
    metadata: { executionId },
  };
}
async function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(100);
  const registry = new MemoryRunRegistryStore();
  // 固定时间有意模拟同毫秒 ABA；execution identity 仍必须阻止旧控制请求。
  const supervisor = new DefaultRunSupervisor({ registryStore: registry, now: () => 100, maxActiveRuns: 1 });
  const old = await supervisor.registerRun(registration('old', 'execution-old'));
  await old.markPaused();
  const target = { runId: old.runId, expectedUpdatedAt: 100, expectedExecutionId: ExecutionIdSchema.parse('execution-old') };
  return { registry, supervisor, old, target };
}

describe('paused run replacement admission', () => {
  afterEach(() => vi.restoreAllMocks());
  it('新输入提交失败保留原暂停身份、并发名额和继续能力', async () => {
    const f = await fixture();
    await expect(f.supervisor.registerRun({
      ...registration('new', 'execution-new'), replacesPausedRun: f.target,
      admissionCommit: async () => { throw new Error('input commit failed'); },
    })).rejects.toThrow('input commit failed');
    expect(await f.registry.load(f.old.runId)).toMatchObject({ status: 'paused', pausedAt: 100 });
    expect(await f.registry.load(RunIdSchema.parse('new'))).toBeNull();
    await expect(f.supervisor.resumePausedRun({ ...f.target,
      eventBus: new EventBus(ExecutionIdSchema.parse('continued')), executionId: ExecutionIdSchema.parse('continued'),
    })).resolves.toBe(f.old);
  });

  it('两个新请求竞争只接纳一次；原运行终止后旧继续不能复活', async () => {
    const f = await fixture();
    const accepted: string[] = [];
    const admissionCommit: NonNullable<RunRegistrationSpec['admissionCommit']> = async (record, replacement) => {
      if (!replacement) throw new Error('missing replacement');
      expect(await f.registry.compareAndSwap(replacement.previous, replacement.next)).toBe(true);
      await f.registry.save(record);
      accepted.push(record.runId);
    };
    const results = await Promise.allSettled(['first', 'second'].map(id => f.supervisor.registerRun({
      ...registration(id, `execution-${id}`), replacesPausedRun: f.target, admissionCommit,
    })));
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(accepted).toEqual(['first']);
    expect(await f.registry.load(f.old.runId)).toMatchObject({ status: 'cancelled', errorIfAny: { errorCode: 'RUN_REPLACED' } });
    await expect(f.supervisor.resumePausedRun({ ...f.target,
      eventBus: new EventBus(ExecutionIdSchema.parse('late')), executionId: ExecutionIdSchema.parse('late'),
    })).rejects.toThrow();
  });

  it('同毫秒再次暂停拒绝旧 execution 的继续命令', async () => {
    const f = await fixture();
    await f.supervisor.resumePausedRun({ ...f.target,
      eventBus: new EventBus(ExecutionIdSchema.parse('second')), executionId: ExecutionIdSchema.parse('second'),
    });
    await f.old.markPaused();
    await expect(f.supervisor.resumePausedRun({ ...f.target,
      eventBus: new EventBus(ExecutionIdSchema.parse('late')), executionId: ExecutionIdSchema.parse('late'),
    })).rejects.toThrow('expected pause');
  });

  it('交互响应和激活通过同一提交口；失败后原审批仍可重试', async () => {
    const f = await fixture();
    const interaction = { interactionId: 'interaction', toolCallId: 'tool', checkpointRevision: 7, resumeToken: 'token' };
    await f.old.markAwaitingUser({ interaction, eventId: 'interaction-fact' });
    const claim = await f.supervisor.claimResume(f.old.runId, interaction, new EventBus(ExecutionIdSchema.parse('response')));
    await expect(claim.activate({
      executionId: ExecutionIdSchema.parse('response'), inputEventIds: ['response-fact'],
      admissionCommit: async () => { throw new Error('response commit failed'); },
    })).rejects.toThrow('response commit failed');
    await claim.release();
    const retry = await f.supervisor.claimResume(f.old.runId, interaction, new EventBus(ExecutionIdSchema.parse('retry')));
    await retry.activate({
      executionId: ExecutionIdSchema.parse('retry'), inputEventIds: ['response-fact'],
      admissionCommit: async (previous, next) => {
        expect(previous.status).toBe('awaiting_user');
        expect(next.metadata?.resumeInputs).toEqual({ eventIds: ['response-fact'], checkpointRevision: 7 });
        expect(await f.registry.compareAndSwap(previous, next)).toBe(true);
      },
    });
    expect(await f.registry.load(f.old.runId)).toMatchObject({ status: 'running', metadata: { executionId: 'retry' } });
  });
});
