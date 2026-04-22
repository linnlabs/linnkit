/**
 * @file src/agent/runtime-kernel/system-reminder/rules.ts
 * @description SystemReminder 规则集合（配置入口）
 *
 * 中文备注：
 * - 这是希望的“只改一个 TS 文件就能新增提醒策略”的位置。
 * - 规则必须是纯函数：只能基于 ctx（request/history/executorLocal）计算文本，禁止写副作用。
 */

import type { SystemReminderContext, SystemReminderRule } from './types';

const readNonEmptyStrings = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0);
};

const toDisplayStep = (nodeSwitches: number): number => Math.ceil(nodeSwitches / 2);

const isRuntimeEventLike = (v: unknown): v is { type: unknown } => {
  return !!v && typeof v === "object" && !Array.isArray(v) && "type" in v;
};

/**
 * 统计“本轮请求内”的工具调用次数（LLM 决策层）
 *
 * 口径（根因级说明）：
 * - reminder 只对当前 request 生效，因此只统计“最后一次 user_input 之后”的工具调用决策次数；
 * - 旧模型里 ToolNode 也会复用 `action`，导致统计一轮工具调用时被重复计数；
 * - 现在只统计显式的 `tool_call_decision`，语义就是“LLM 决策发起的 tool_call”。
 */
const countToolCallsInCurrentRequest = (history: ReadonlyArray<unknown>): number => {
  // 1) 找到最后一个 user_input 作为“本轮 request 的起点”
  let startIdx = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const evt = history[i];
    if (!isRuntimeEventLike(evt)) continue;
    if (evt.type === 'user_input') {
      startIdx = i + 1;
      break;
    }
  }

  // 2) 统计起点之后的 tool_calls 次数
  let count = 0;
  for (let i = startIdx; i < history.length; i += 1) {
    const evt = history[i];
    if (!isRuntimeEventLike(evt)) continue;
    if (evt.type === 'tool_call_decision') {
      count += 1;
    }
  }
  return count;
};

/**
 * ✅ 规则：MaxSteps 最后一步强制收尾（禁用工具）
 *
 * 说明：
 * - 仅在 phase='force_final_answer' 时触发
 * - 注入为 <system-reminder>，追加到最后一条消息末尾（利用注意力末尾效应）
 */
const maxStepsForceFinalAnswer: SystemReminderRule = {
  id: 'max_steps_force_final_answer',
  when: (ctx: SystemReminderContext) => ctx.executorLocal?.phase === 'force_final_answer',
  build: () => {
    return [
      '你已达到最大步数限制：本轮工具已被禁用。',
      '你必须立刻给出最终答案，不要再尝试调用任何工具。',
      '若信息不完整，请明确说明关键假设和缺口，并给出当前最好的可用回答。',
    ].join('\n');
  },
};

/**
 * ✅ 规则：最后几步提示（remainingSteps <= threshold）
 *
 * 说明：
 * - phase='force_final_answer' 时不再重复注入（由 maxStepsForceFinalAnswer 覆盖）
 * - force_tools 时：提示“剩余 1 步必须调用指定工具”，并强调最后 1 步留给 ToolNode 执行
 */
const lastStepsHint: SystemReminderRule = {
  id: 'last_steps_hint',
  when: (ctx: SystemReminderContext) => {
    const el = ctx.executorLocal;
    if (!el) return false;
    if (el.phase === 'force_final_answer') return false;
    const threshold = el.lastStepsHintThreshold ?? 0;
    const remainingSteps = el.remainingSteps;
    if (typeof threshold !== 'number' || threshold <= 0) return false;
    if (typeof remainingSteps !== 'number') return false;
    return remainingSteps <= threshold;
  },
  build: (ctx: SystemReminderContext) => {
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
  },
};

/**
 * ✅ 规则：连续 N 次工具调用提醒（默认 N=10）
 *
 * 说明：
 * - 用于防止“工具循环过深导致上下文膨胀/注意力分散”
 * - 触发时机：本轮 request 的 tool_calls 次数达到 10、20、30...（避免每 tick 都刷屏）
 */
const toolCallStreakEveryTen: SystemReminderRule = {
  id: 'tool_call_streak_every_ten',
  when: (ctx: SystemReminderContext) => {
    const count = countToolCallsInCurrentRequest(ctx.history);
    return count >= 10 && count % 10 === 0;
  },
  build: (ctx: SystemReminderContext) => {
    const count = countToolCallsInCurrentRequest(ctx.history);
    // 中文备注：这里不做“防御性兜底”，count 的口径由 helper 保证；若异常则直接输出 count 结果。
    return [
      `你已连续执行了 ${count} 次工具调用。`,
      '如果问题比较复杂，考虑创建sub-agent，也就是task，以降低上下文占用。',
      '如果问题即将解决，请忽略本条提醒。',
    ].join('\n');
  },
};

/**
 * 系统提醒规则列表（按顺序执行）
 *
 * 中文备注：
 * - 这里的顺序会影响“多条提醒合并时的排列顺序”
 * - 不建议在这里做跨规则依赖（保持低耦合）
 */
/**
 * ✅ 规则：周期性 TaskState 反思提醒
 *
 * 触发条件：stepCount 达到 30、60、90...（每 30 次节点切换，约 15 个 LLM 决策步）
 * 用途：长程任务中定期提醒 agent 检查和更新 TaskState，防止目标漂移
 */
const periodicTaskstateReflection: SystemReminderRule = {
  id: 'periodic_taskstate_reflection',
  when: (ctx: SystemReminderContext) => {
    const el = ctx.executorLocal;
    if (!el) return false;
    if (el.phase === 'force_final_answer') return false;
    const stepCount = el.stepCount;
    if (typeof stepCount !== 'number' || stepCount < 30) return false;
    return stepCount % 30 === 0;
  },
  build: (ctx: SystemReminderContext) => {
    const el = ctx.executorLocal;
    const stepCount = el?.stepCount ?? 0;
    const displayStep = toDisplayStep(stepCount);
    return [
      `你已执行了 ${displayStep} 步。请暂停当前工作，花一步反思和整理：`,
      '1. 回顾你最近的 taskstate_write 输出，确认当前工作方向正确（没有偏离 Goal）。',
      '2. 调用 taskstate_write 更新 progress 和 next_steps，如有必要调整 current_plan。',
      '3. 如果任务复杂但尚未创建 TaskState，现在是创建的好时机。',
      '完成整理后继续执行任务。',
    ].join('\n');
  },
};

/**
 * ✅ 规则：上下文预算告警
 *
 * 触发条件：stepCount 达到 maxSteps 的 90%（4 步窗口，约 2 个工具调用周期）
 * 用途：提醒 agent 上下文即将耗尽，需要调用 context_checkpoint 清理上下文
 * 适用范围：仅对拥有 context_checkpoint 工具的 agent 生效（当前只有 default agent）
 *   - 子 agent 即使未配置 systemReminder.ruleIds 白名单，也不会被误触发
 * 设计：
 *   - 使用 stepCount（节点切换次数）而非 history.length（事件数），
 *     因为事件数因模型类型差异很大（思考模型 ~5 事件/步 vs 非思考模型 ~2 事件/步）
 *   - stepCount 在 checkpoint 后由 GraphExecutor 重置为 0，
 *     所以每个 checkpoint 周期都会在 90% 处重新触发告警
 *   - 与 periodicTaskstateReflection / lastStepsHint 保持一致，统一基于 stepCount
 */
const contextBudgetWarning: SystemReminderRule = {
  id: 'context_budget_warning',
  when: (ctx: SystemReminderContext) => {
    // 语义级守卫：该提醒引导模型调用 context_checkpoint，只有拥有该工具的 agent 才有意义
    const tools = ctx.request.availableTools;
    if (!Array.isArray(tools) || !tools.includes('context_checkpoint')) return false;

    const el = ctx.executorLocal;
    if (!el) return false;
    if (el.phase === 'force_final_answer') return false;
    const stepCount = el.stepCount;
    const maxSteps = el.maxSteps;
    if (typeof stepCount !== 'number' || typeof maxSteps !== 'number' || maxSteps <= 0) return false;
    // 在总步数的 90% 处触发（窗口 4 步 ≈ 2 个工具调用周期，避免每步都刷）
    const threshold = Math.floor(maxSteps * 0.9);
    return stepCount >= threshold && stepCount < threshold + 4;
  },
  build: (ctx: SystemReminderContext) => {
    const el = ctx.executorLocal;
    const stepCount = el?.stepCount ?? 0;
    const maxSteps = el?.maxSteps ?? 0;
    const displayStep = toDisplayStep(stepCount);
    const displayMax = toDisplayStep(maxSteps);
    return [
      `⚠️ 上下文预算告警：你已执行了 ${displayStep}/${displayMax} 步，上下文空间即将耗尽。`,
      '你必须立即执行以下操作以避免上下文溢出：',
      '1. 调用sharedmemory_write工具，将当前发现、总结、思考或者任何重要信息详细写入sharedmemory。',
      '2. 调用 context_checkpoint 工具，传入 summary（阶段过渡摘要）和 taskstate（最新任务状态）。',
      '   这会一次性完成"保存状态 + 清理历史"，checkpoint tool_output 中会保留你的 TaskState 快照。',
      '3. 清理后你的上下文将只保留：checkpoint 工具对（含摘要 + TaskState）+ 最近 2 对工具交互。重要信息会通过sharedmemory保存。',
    ].join('\n');
  },
};

export const SYSTEM_REMINDER_RULES: ReadonlyArray<SystemReminderRule> = [
  maxStepsForceFinalAnswer,
  lastStepsHint,
  toolCallStreakEveryTen,
  periodicTaskstateReflection,
  contextBudgetWarning,
];
