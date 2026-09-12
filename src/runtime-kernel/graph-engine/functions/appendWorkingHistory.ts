import type { RuntimeEvent } from '../../../contracts';
import { shouldPersistRuntimeEvent } from '../../events/eventGovernance';

/**
 * Working history 随 checkpoint 保存，只保留 durable 事实；实时 journal 仍持有全部事件。
 *
 * 同时投影原历史，确保合法旧 checkpoint 在正常节点合并时也不再携带流式进度。
 * 不能使用 Agent-context 资格替代持久资格：完整 thought、error/control 等仍属于恢复/审计事实。
 */
export function appendWorkingHistory(
  history: readonly RuntimeEvent[],
  events: readonly RuntimeEvent[],
): RuntimeEvent[] {
  return [...history.filter(shouldPersistRuntimeEvent), ...events.filter(shouldPersistRuntimeEvent)];
}
