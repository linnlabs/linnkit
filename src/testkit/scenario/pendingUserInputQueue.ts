import type { PendingUserInput, PendingUserInputPort } from '../../runtime-kernel';

export type PendingUserInputWithdrawResult = 'withdrawn' | 'claimed' | 'delivered' | 'unknown';

export interface PendingUserInputQueue {
  /** 交给 Graph 的端口；claim / confirm / release 语义与 Host 合同一致。 */
  readonly port: PendingUserInputPort;
  /** 提交一条插话，返回它的 id（也是送达后 user_input 事实的 id）。 */
  submit(content: string, options?: { id?: string; timestamp?: number }): string;
  /** 只能撤回还没被取用的；已被取用或已送达的保持原状。 */
  withdraw(id: string): PendingUserInputWithdrawResult;
  /** 取走全部未取用的（运行结束时 Host 收回没送达的插话）。 */
  drain(): PendingUserInput[];
  pending(): readonly PendingUserInput[];
  claimed(): readonly PendingUserInput[];
  delivered(): readonly PendingUserInput[];
}

/**
 * 内存版插话队列：给测试和最小 Host 用的 PendingUserInputPort 参考实现。
 */
export function createPendingUserInputQueue(): PendingUserInputQueue {
  let pending: PendingUserInput[] = [];
  const claimed = new Map<string, PendingUserInput>();
  const delivered: PendingUserInput[] = [];
  let sequence = 0;

  const port: PendingUserInputPort = {
    claim() {
      const taken = pending;
      pending = [];
      for (const input of taken) claimed.set(input.id, input);
      return taken;
    },
    confirm(ids) {
      for (const id of ids) {
        const input = claimed.get(id);
        if (!input) continue;
        claimed.delete(id);
        delivered.push(input);
      }
    },
    release(ids) {
      const returned = ids.flatMap(id => {
        const input = claimed.get(id);
        claimed.delete(id);
        return input ? [input] : [];
      });
      pending = [...returned, ...pending];
    },
  };

  return {
    port,
    submit(content, options = {}) {
      sequence += 1;
      const id = options.id ?? `steer_${sequence}`;
      pending.push({ id, content, timestamp: options.timestamp ?? Date.now() });
      return id;
    },
    withdraw(id) {
      if (pending.some(input => input.id === id)) {
        pending = pending.filter(input => input.id !== id);
        return 'withdrawn';
      }
      if (claimed.has(id)) return 'claimed';
      if (delivered.some(input => input.id === id)) return 'delivered';
      return 'unknown';
    },
    drain() {
      const taken = pending;
      pending = [];
      return taken;
    },
    pending: () => [...pending],
    claimed: () => [...claimed.values()],
    delivered: () => [...delivered],
  };
}
