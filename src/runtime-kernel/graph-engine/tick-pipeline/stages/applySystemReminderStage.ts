import { applySystemReminders } from '../../../system-reminder/apply';
import type { TickPipelineContext, TickStage } from '../types';
import type { AiMessage } from '../../../../contracts';

export function createApplySystemReminderStage(): TickStage {
  return {
    id: 'apply_system_reminder',
    async run(ctx: TickPipelineContext): Promise<void> {
      ctx.systemReminderHitRuleIds = undefined;
      ctx.llmMessages = applySystemReminders({
        llmMessages: ctx.llmMessages,
        ctx: {
          request: ctx.request,
          history: ctx.history,
          executorLocal: ctx.executorLocal,
        },
        policy: ctx.executorLocal?.systemReminderPolicy,
        onInjected: ({ ruleIds }) => {
          ctx.systemReminderHitRuleIds = Array.isArray(ruleIds) ? ruleIds : [];
        },
      }) as AiMessage[];
    },
  };
}
