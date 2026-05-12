import type { AgentSpecSystemReminderTrigger } from '../../contracts';
import { countToolCallsInCurrentRequest, readContextCheckpointToolName } from './helpers';
import type { SystemReminderContext, SystemReminderTriggerEvaluator } from './types';

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getTriggerThreshold(trigger: AgentSpecSystemReminderTrigger): number | undefined {
  return readNumber(trigger.threshold);
}

export const phaseEqualsTrigger: SystemReminderTriggerEvaluator = (ctx, trigger) => {
  const expected = readString(trigger.value);
  return !!expected && ctx.executorLocal?.phase === expected;
};

export const remainingStepsLeqTrigger: SystemReminderTriggerEvaluator = (ctx, trigger) => {
  const remainingSteps = readNumber(ctx.executorLocal?.remainingSteps);
  const threshold = getTriggerThreshold(trigger) ?? readNumber(ctx.executorLocal?.lastStepsHintThreshold);
  if (remainingSteps === undefined || threshold === undefined || threshold <= 0) return false;
  if (ctx.executorLocal?.phase === 'force_final_answer') return false;
  return remainingSteps <= threshold;
};

export const stepCountModuloTrigger: SystemReminderTriggerEvaluator = (ctx, trigger) => {
  const stepCount = readNumber(ctx.executorLocal?.stepCount);
  const period = readNumber(trigger.period) ?? getTriggerThreshold(trigger);
  const minStep = readNumber(trigger.minStep) ?? period;
  if (stepCount === undefined || period === undefined || period <= 0) return false;
  if (ctx.executorLocal?.phase === 'force_final_answer') return false;
  if (stepCount < (minStep ?? 0)) return false;
  return stepCount % period === 0;
};

export const toolCallStreakTrigger: SystemReminderTriggerEvaluator = (ctx, trigger) => {
  const threshold = getTriggerThreshold(trigger) ?? 10;
  if (threshold <= 0) return false;
  const count = countToolCallsInCurrentRequest(ctx.history);
  if (count < threshold) return false;
  return trigger.moduloStep === false ? true : count % threshold === 0;
};

export const budgetWarningTrigger: SystemReminderTriggerEvaluator = (ctx, trigger) => {
  const toolName = readString(trigger.toolName) ?? readContextCheckpointToolName(ctx);
  const tools = ctx.request.availableTools;
  if (!Array.isArray(tools) || !tools.includes(toolName)) return false;

  const stepCount = readNumber(ctx.executorLocal?.stepCount);
  const maxSteps = readNumber(ctx.executorLocal?.maxSteps);
  const ratio = readNumber(trigger.ratio) ?? 0.9;
  if (stepCount === undefined || maxSteps === undefined || maxSteps <= 0) return false;
  if (ctx.executorLocal?.phase === 'force_final_answer') return false;

  const threshold = Math.floor(maxSteps * ratio);
  return stepCount >= threshold && stepCount < threshold + 4;
};

export const agentHasToolTrigger: SystemReminderTriggerEvaluator = (ctx, trigger) => {
  const toolName = readString(trigger.toolName) ?? readString(trigger.value);
  if (!toolName || !Array.isArray(ctx.request.availableTools)) return false;
  return ctx.request.availableTools.includes(toolName);
};

export const BUILTIN_SYSTEM_REMINDER_TRIGGERS: Record<string, SystemReminderTriggerEvaluator> = {
  'phase-equals': phaseEqualsTrigger,
  'remaining-steps-leq': remainingStepsLeqTrigger,
  'step-count-modulo': stepCountModuloTrigger,
  'tool-call-streak': toolCallStreakTrigger,
  'budget-warning': budgetWarningTrigger,
  'agent-has-tool': agentHasToolTrigger,
};
