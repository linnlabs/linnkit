import { applySystemReminders } from '../../../system-reminder/apply';
import { SYSTEM_REMINDER_RULES } from '../../../system-reminder/rules';
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
        rules: (() => {
          const ids = ctx.executorLocal?.systemReminderRuleIds;
          if (!Array.isArray(ids) || ids.length === 0) {
            return undefined;
          }
          const allow = new Set(
            ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
          );
          const filtered = SYSTEM_REMINDER_RULES.filter((rule) => allow.has(rule.id));
          return filtered.length > 0 ? filtered : [];
        })(),
        onInjected: ({ ruleIds }) => {
          ctx.systemReminderHitRuleIds = Array.isArray(ruleIds) ? ruleIds : [];
        },
      }) as AiMessage[];
    },
  };
}
