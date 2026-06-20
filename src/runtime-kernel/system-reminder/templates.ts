import {
  countToolCallsInCurrentRequest,
  readContextCheckpointToolName,
  readNonEmptyStrings,
  toDisplayStep,
} from './helpers';
import type { SystemReminderContentTemplate, SystemReminderContext } from './types';

export const maxStepsForceFinalAnswerTemplate: SystemReminderContentTemplate = () => [
  '你已达到最大步数限制：本轮工具已被禁用。',
  '你必须立刻给出最终答案，不要再尝试调用任何工具。',
  '若信息不完整，请明确说明关键假设和缺口，并给出当前最好的可用回答。',
].join('\n');

export const lastStepsHintTemplate: SystemReminderContentTemplate = (ctx) => {
  const el = ctx.executorLocal;
  if (!el) return '';
  const maxSteps = el.maxSteps;
  const stepCount = el.stepCount;
  const remainingSteps = el.remainingSteps;
  if (typeof maxSteps !== 'number' || typeof stepCount !== 'number' || typeof remainingSteps !== 'number') {
    return '';
  }

  const displayMaxSteps = toDisplayStep(maxSteps);
  const displayStepCount = toDisplayStep(stepCount);
  const displayRemainingSteps = toDisplayStep(remainingSteps);
  const finalStepPolicy = el.finalStepPolicy ?? 'final_answer';

  if (finalStepPolicy === 'force_tools') {
    const forcedTools = readNonEmptyStrings(el.finalStepForcedTools);
    const toolsText = forcedTools.length > 0 ? forcedTools.join(', ') : '(未配置 forcedTools)';
    return [
      `步数提醒：你当前处于第 ${displayStepCount}/${displayMaxSteps} 步，还剩 ${displayRemainingSteps} 步。`,
      `当剩余 1 步时：你必须立刻调用工具：${toolsText}（系统将只保留这些工具）。`,
      '最后 1 步将用于执行工具，因此不要在最后一步才尝试再调用其他工具。',
    ].join('\n');
  }

  return [
    `步数提醒：你当前处于第 ${displayStepCount}/${displayMaxSteps} 步，还剩 ${displayRemainingSteps} 步。`,
    '建议你结束无关推理/无关工具调用，确保在步数耗尽前完成任务。',
  ].join('\n');
};

export const toolCallStreakTemplate: SystemReminderContentTemplate = (ctx) => {
  const count = countToolCallsInCurrentRequest(ctx.history);
  return [
    `你已连续执行了 ${count} 次工具调用。`,
    '如果问题比较复杂，考虑创建sub-agent，也就是task，以降低上下文占用。',
    '如果问题即将解决，请忽略本条提醒。',
  ].join('\n');
};

export const periodicTaskstateReflectionTemplate: SystemReminderContentTemplate = (ctx) => {
  const stepCount = ctx.executorLocal?.stepCount ?? 0;
  const displayStep = toDisplayStep(stepCount);
  return [
    `你已执行了 ${displayStep} 步。请暂停当前工作，花一步反思和整理：`,
    '1. 回顾你最近的 taskstate_write 输出，确认当前工作方向正确（没有偏离 Goal）。',
    '2. 调用 taskstate_write 更新 progress 和 next_steps，如有必要调整 current_plan。',
    '3. 如果任务复杂但尚未创建 TaskState，现在是创建的好时机。',
    '完成整理后继续执行任务。',
  ].join('\n');
};

export const contextBudgetWarningTemplate: SystemReminderContentTemplate = (ctx) => {
  const stepCount = ctx.executorLocal?.stepCount ?? 0;
  const maxSteps = ctx.executorLocal?.maxSteps ?? 0;
  const displayStep = toDisplayStep(stepCount);
  const displayMax = toDisplayStep(maxSteps);
  const checkpointToolName = readContextCheckpointToolName(ctx);
  return [
    `⚠️ 上下文预算告警：你已执行了 ${displayStep}/${displayMax} 步，上下文空间即将耗尽。`,
    '你必须立即执行以下操作以避免上下文溢出：',
    '1. 先确认关键进展、约束、下一步已经进入 TaskState；如果没有，请调用 taskstate_write 更新。',
    `2. 调用 ${checkpointToolName} 工具，传入 summary（阶段过渡摘要）和 taskstate（最新任务状态）。`,
    '   这会一次性完成"保存状态 + 清理历史"，checkpoint tool_output 中会保留你的 TaskState 快照。',
    '3. 清理后你的上下文将只保留：checkpoint 工具对（含摘要 + TaskState）+ 最近 2 对工具交互。需要长期交付给用户的内容请写入 Workspace 文件。',
  ].join('\n');
};

export const BUILTIN_SYSTEM_REMINDER_TEMPLATES: Record<string, SystemReminderContentTemplate> = {
  maxStepsForceFinalAnswer: maxStepsForceFinalAnswerTemplate,
  lastStepsHint: lastStepsHintTemplate,
  toolCallStreak: toolCallStreakTemplate,
  periodicTaskstateReflection: periodicTaskstateReflectionTemplate,
  contextBudgetWarning: contextBudgetWarningTemplate,
};
