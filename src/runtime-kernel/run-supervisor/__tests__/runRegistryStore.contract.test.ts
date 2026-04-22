import { describe, expect, it } from 'vitest';

import { MemoryRunRegistryStore } from '../memoryRunRegistryStore';
import type { RunRecord } from '../runRegistryStorePort';

function createRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    status: 'running',
    startedAt: 10,
    updatedAt: 10,
    ...overrides,
  };
}

describe('RunRegistryStore contract', () => {
  it('round-trips saved records by runId', async () => {
    const store = new MemoryRunRegistryStore();
    const record = createRunRecord({
      parentRunId: 'parent-1',
      iterationsUsed: 3,
      metadata: { feature: 'deep-research' },
    });

    await store.save(record);

    await expect(store.load('run-1')).resolves.toEqual(record);
  });

  it('lists runs by status and parentRunId filters', async () => {
    const store = new MemoryRunRegistryStore();

    await store.save(createRunRecord({ runId: 'run-1', parentRunId: 'parent-1', status: 'running' }));
    await store.save(createRunRecord({ runId: 'run-2', parentRunId: 'parent-1', status: 'completed' }));
    await store.save(createRunRecord({ runId: 'run-3', parentRunId: 'parent-2', status: 'running' }));

    const result = await store.list({ status: 'running', parentRunId: 'parent-1' });

    expect(result.nextCursor).toBeUndefined();
    expect(result.runs).toEqual([
      createRunRecord({ runId: 'run-1', parentRunId: 'parent-1', status: 'running' }),
    ]);
  });

  it('deletes records by runId', async () => {
    const store = new MemoryRunRegistryStore();

    await store.save(createRunRecord());
    await store.delete('run-1');

    await expect(store.load('run-1')).resolves.toBeNull();
  });
});
