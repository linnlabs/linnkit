import { applySystemReminders } from '../../../system-reminder/apply';
import { defineTickStage } from '../types';
import type { TickStage } from '../types';

export function createApplySystemReminderStage(): TickStage {
  return defineTickStage({
    id: 'apply_system_reminder',
    reads: ['llmMessages', 'request', 'history', 'executorLocal'],
    writes: ['systemReminderHitRuleIds', 'llmMessages'],
    async run(ctx) {
      let systemReminderHitRuleIds: string[] | undefined;
      const llmMessages = applySystemReminders({
        llmMessages: ctx.llmMessages,
        ctx: {
          request: ctx.request,
          history: ctx.history,
          executorLocal: ctx.executorLocal,
        },
        policy: ctx.executorLocal?.systemReminderPolicy,
        onInjected: ({ ruleIds }) => {
          systemReminderHitRuleIds = Array.isArray(ruleIds) ? ruleIds : [];
        },
      });

      return {
        systemReminderHitRuleIds,
        llmMessages,
      };
    },
  });
}
