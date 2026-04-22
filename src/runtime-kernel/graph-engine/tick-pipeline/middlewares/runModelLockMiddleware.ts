import { Logger } from '../../../../shared/logger';
import { readNonEmptyString } from '../helpers';
import type { TickAroundMiddleware } from '../types';

const logger = new Logger('GraphAgentExecutor');

export const runModelLockMiddleware: TickAroundMiddleware = async (ctx, stage, next) => {
  await next();

  if (stage.id !== 'execute_llm') {
    return;
  }

  const normalized = readNonEmptyString(ctx.cloudQuotaFallbackAppliedModelId);
  if (!normalized) {
    return;
  }
  if (ctx.executorLocal?.runLockedModelId === normalized) {
    return;
  }
  if (ctx.executorLocal) {
    ctx.executorLocal.runLockedModelId = normalized;
  }
  logger.warn(`检测到云端额度降级，已锁定本 run 后续模型: ${ctx.modelId} -> ${normalized}`);
};
