import type { RunRecord, RunRegistryStore } from '../runRegistryStorePort';
import { RunInteractionConflictError } from '../runErrors';

export async function persistRunTransition(store: RunRegistryStore, previous: RunRecord, next: RunRecord): Promise<void> {
  if (store.compareAndSwap) {
    if (!await store.compareAndSwap(previous, next)) {
      throw new RunInteractionConflictError(previous.runId, 'run changed before lifecycle commit');
    }
  } else {
    // 未接入恢复的旧 Host 保持原 store 合同；恢复装配必须提供原子比较更新。
    await store.save(next);
  }
}
