import {
  recordAfterContextManager,
  recordAfterContextManagerOnSystemReminderHit,
  recordBeforeContextManager,
} from '../../../../shared/llmAuditRecorder';
import { resolveToolNamesForAudit } from '../helpers';
import type { TickAroundMiddleware } from '../types';

export const contextAuditMiddleware: TickAroundMiddleware = async (ctx, stage, next) => {
  if (stage.id === 'build_context') {
    recordBeforeContextManager({
      mode: ctx.request.mode === 'chat' ? 'chat' : 'agent',
      payload: ctx.request.mode === 'chat'
        ? { request: ctx.request }
        : { request: ctx.request, history: ctx.history },
    });
  }

  await next();

  if (stage.id !== 'apply_system_reminder') {
    return;
  }

  const toolNamesForAudit = resolveToolNamesForAudit(ctx);
  recordAfterContextManager({
    mode: ctx.mode,
    llmMessages: ctx.llmMessages,
    toolNames: toolNamesForAudit,
  });

  if (Array.isArray(ctx.systemReminderHitRuleIds) && ctx.systemReminderHitRuleIds.length > 0) {
    recordAfterContextManagerOnSystemReminderHit({
      mode: ctx.mode,
      llmMessages: ctx.llmMessages,
      toolNames: toolNamesForAudit,
      systemReminder: { ruleIds: ctx.systemReminderHitRuleIds },
    });
  }
};
