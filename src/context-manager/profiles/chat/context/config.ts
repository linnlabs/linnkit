/**
 * @file src/chat/context/config.ts
 * @description 上下文构建策略配置 - 多阶段智能填充配置中心
 * 
 * 🎯 目的: 为ContextManager提供所有策略参数的可配置中心
 * 📖 详情: 实现README中描述的3阶段上下文构建策略
 */

/**
 * 上下文构建器核心配置
 * 
 * 🎯 统一管理所有Token限制、触发条件和策略参数
 * 基于README第183-205行的规格实现
 */
export const CONTEXT_BUILDER_CONFIG = {
  // === 绝对Token限制设置 ===
  
  /** 默认最大Token预算上限 */
  DEFAULT_MAX_TOKENS: 120000,
  
  /** 响应预留Token数 */
  RESERVED_FOR_RESPONSE: 2000,
  
  /** 系统提示词预留token数 (v4.0架构中暂未使用，予以保留以备未来扩展) */
  // SYSTEM_PROMPT_RESERVED_TOKENS: 2000, // 决定暂时注释而不是删除，以便追溯
  
  // --- 百分比相关配置说明 ---
  //
  // 除非特殊说明，以下所有百分比配置的基准都是【可用上下文总预算】。
  // 【可用上下文总预算】 = DEFAULT_MAX_TOKENS - RESERVED_FOR_RESPONSE
  // 例如，在 8k 模型和 2k 响应预留的情况下，基准预算为 6000 Token。
  //
  // ---

  // === 工作记忆填充策略 ===
  
  /**
   * 工作记忆填充目标百分比 (当前未使用)。
   * - **说明**: 在当前架构中，WorkingMemoryProvider会尽力填充100%可用预算，
   *   而摘要触发由SummarizationProvider基于SUMMARIZATION_TRIGGER_THRESHOLD控制。
   *   此配置项预留以备未来需要精确控制填充上限时使用。
   */
  // BUDGET_PERCENTAGE: 0.90,
  
  /**
   * 摘要触发阈值百分比。
   * - **基准**: 可用上下文总预算。
   * - **说明**: 当已用Token总量（精确计算后）超过此百分比时，将触发摘要机制。
   *   例如，0.85 表示使用量超过85%就触发摘要。
   */
  SUMMARIZATION_TRIGGER_THRESHOLD: 0.7,
  
  // === 摘要策略设置 ===
  
  /**
   * 摘要消息长度上限百分比。
   * - **基准**: 可用上下文总预算。
   * - **说明**: AI生成的摘要文本，其Token长度不应超过此百分比。
   *   用于限制摘要本身的体积，确保对话可持续。
   */
  SUMMARY_BUDGET_PERCENTAGE: 0.10,
  
  /**
   * 选取摘要候选消息的比例。
   * - **基准**: 符合摘要条件的消息**数量** (非Token)。
   * - **说明**: 在触发摘要时，从符合条件的历史消息中，选取最老的百分之多少来进行压缩。
   *   例如，0.8 表示选取最老的80%的消息作为摘要的原材料。
   */
  SUMMARY_OLDEST_MESSAGES_PERCENTAGE: 0.80,
  
  // === 文档处理策略 ===
  
  /**
   * 文档片段最大占比。
   * - **基准**: 可用上下文总预算。
   * - **说明**: 为保证核心请求的完整性，在极端情况下，单个文档片段的Token数会被截断，
   *   确保其不超过此百分比。这是一个“硬上限”。
   */
  DOCUMENT_FRAGMENT_MAX_PERCENTAGE: 0.20,
  
  // === 思维链回补策略 ===
  
  /** 最多回补最近几次对话的思维链 */
  THINKING_RECALL_COUNT: 2,
  
  // === 消息类型优先级定义 ===
  
  /** 核心上下文保留层消息类型 (Must-Keep) - 第一阶段 */
  CORE_MESSAGE_TYPES: ['system_prompt', 'user_input', 'document_fragment'] as const,
  
  /** 优先填充内容类型 (P1) - 第二阶段优先 */
  PRIORITY_CONTENT_TYPES: ['final_answer', 'task_completion', 'user_input'] as const,
  
  /** 次要填充内容类型 (P2) - 第二阶段次优先 */
  SECONDARY_CONTENT_TYPES: ['thought'] as const,
  
  // === Token估算配置 ===
  
  /** 平均每个字符的token估算比例 (用于快速预估) */
  AVG_CHARS_PER_TOKEN: 2.0,
    
  // === 模型配置 ===
  
  /**
   * Token 精确估算用的“模型标识”（用于映射到 tiktoken encoding）
   *
   * 说明：
   * - 这里只用于 `TokenCalculator.estimateTokensPrecise(...)` 的 encoding 选择，不用于真实 LLM 调用；
   * - 为避免把某个具体业务模型写死在这里，统一使用 tiktoken 的默认 encoding：cl100k_base。
   */
  DEFAULT_MODEL_ID: 'cl100k_base',
  
  // === 性能与调试配置 ===
  
  /** 是否启用详细的构建统计 */
  ENABLE_BUILD_STATS: true,
  
  /** 是否启用阶段执行时间统计 */
  ENABLE_TIMING_STATS: true,
  
  /** 上下文构建超时阈值 (毫秒) */
  PROCESSING_TIMEOUT_MS: 1000,
  
  /** 大量摘要消息警告阈值 */
  LARGE_SUMMARIZATION_WARNING_THRESHOLD: 5,
  
} as const;

/**
 * 上下文构建策略配置的类型定义
 * 使用通用类型（如 number）而不是字面量类型，以增加灵活性
 */
export type ContextBuilderConfig = {
  // 绝对Token限制
  readonly DEFAULT_MAX_TOKENS: number;
  readonly RESERVED_FOR_RESPONSE: number;
  // readonly SYSTEM_PROMPT_RESERVED_TOKENS: number;
  
  // 工作记忆填充策略 (当前未使用)
  // readonly BUDGET_PERCENTAGE: number;
  readonly SUMMARIZATION_TRIGGER_THRESHOLD: number;
  
  // 摘要策略
  readonly SUMMARY_BUDGET_PERCENTAGE: number;
  readonly SUMMARY_OLDEST_MESSAGES_PERCENTAGE: number;
  
  // 文档处理策略
  readonly DOCUMENT_FRAGMENT_MAX_PERCENTAGE: number;
  
  // 思维链回补策略
  readonly THINKING_RECALL_COUNT: number;
  
  // 消息类型定义
  readonly CORE_MESSAGE_TYPES: readonly ('system_prompt' | 'user_input' | 'document_fragment')[];
  readonly PRIORITY_CONTENT_TYPES: readonly ('final_answer' | 'task_completion' | 'user_input')[];
  readonly SECONDARY_CONTENT_TYPES: readonly ('thought')[];
  
  // Token估算配置
  readonly AVG_CHARS_PER_TOKEN: number;
  
  // 模型配置
  readonly DEFAULT_MODEL_ID: string;
  
  // 性能与调试配置
  readonly ENABLE_BUILD_STATS: boolean;
  readonly ENABLE_TIMING_STATS: boolean;
  readonly PROCESSING_TIMEOUT_MS: number;
  readonly LARGE_SUMMARIZATION_WARNING_THRESHOLD: number;
};

/**
 * 阶段执行优先级枚举
 * 用于标识和排序3个构建阶段
 */
export enum BuildPhase {
  /** 阶段1: 核心上下文保留层 */
  CORE_CONTEXT = 1,
  
  /** 阶段2: 工作记忆填充层 */
  WORKING_MEMORY = 2,
  
  /** 阶段3: 历史摘要触发层 */
  SUMMARIZATION = 3
}

/**
 * 消息优先级枚举
 * 用于工作记忆填充时的优先级排序
 */
export enum MessagePriority {
  /** 最高优先级: 系统消息和用户输入 */
  CRITICAL = 1,
  
  /** 高优先级: AI最终回答 */
  HIGH = 2,
  
  /** 中优先级: 用户上下文信息 */
  MEDIUM = 3,
  
  /** 低优先级: AI思考过程 */
  LOW = 4
}

/**
 * 上下文构建统计接口
 */
export interface ContextBuildStats {
  /** 构建开始时间 */
  startTime: number;
  
  /** 各阶段执行时间 */
  phaseTiming: Record<BuildPhase, number>;
  
  /** 各阶段token使用情况 */
  phaseTokenUsage: Record<BuildPhase, { used: number; percentage: number }>;
  
  /** 消息数量统计 */
  messageStats: {
    original: number;
    afterCoreContext: number;
    afterWorkingMemory: number;
    afterSummarization: number;
  };
  
  /** 是否触发了摘要机制 */
  summarizationTriggered: boolean;
  
  /** 被摘要的消息数量 */
  summarizedCount?: number;
  
  /** 文档片段是否被截断 */
  documentTruncated: boolean;
  
  /** 总构建时间 */
  totalTime: number;
}

/**
 * 创建自定义上下文构建配置的辅助函数
 * 允许覆盖默认配置的任何部分
 */
export function createContextBuilderConfig(
  overrides: Partial<ContextBuilderConfig>
): ContextBuilderConfig {
  return {
    ...CONTEXT_BUILDER_CONFIG,
    ...overrides
  };
}

// 已移除预算自适应逻辑，统一使用 CONTEXT_BUILDER_CONFIG

/**
 * 验证配置有效性的辅助函数
 */
export function validateConfig(config: ContextBuilderConfig): boolean {
  // 检查绝对Token限制
  if (config.DEFAULT_MAX_TOKENS <= 0) {
    console.warn('DEFAULT_MAX_TOKENS must be positive');
    return false;
  }
  
  if (config.RESERVED_FOR_RESPONSE <= 0 || config.RESERVED_FOR_RESPONSE >= config.DEFAULT_MAX_TOKENS) {
    console.warn('RESERVED_FOR_RESPONSE must be positive and less than DEFAULT_MAX_TOKENS');
    return false;
  }
  
  // 检查百分比配置是否合理
  // BUDGET_PERCENTAGE 验证已移除，因为该配置项当前未被使用
  
  if (config.SUMMARIZATION_TRIGGER_THRESHOLD <= 0 || config.SUMMARIZATION_TRIGGER_THRESHOLD > 1) {
    console.warn('SUMMARIZATION_TRIGGER_THRESHOLD should be between 0 and 1');
    return false;
  }
  
  if (config.SUMMARY_BUDGET_PERCENTAGE <= 0 || config.SUMMARY_BUDGET_PERCENTAGE > 0.5) {
    console.warn('SUMMARY_BUDGET_PERCENTAGE should be between 0 and 0.5');
    return false;
  }
  
  if (config.DOCUMENT_FRAGMENT_MAX_PERCENTAGE <= 0 || config.DOCUMENT_FRAGMENT_MAX_PERCENTAGE > 0.5) {
    console.warn('DOCUMENT_FRAGMENT_MAX_PERCENTAGE should be between 0 and 0.5');
    return false;
  }
  
  // 检查各阶段百分比总和是否合理 (当前跳过，因为BUDGET_PERCENTAGE未被使用)
  // const totalPercentage = config.BUDGET_PERCENTAGE + config.SUMMARY_BUDGET_PERCENTAGE;
  // if (totalPercentage > 1) {
  //   console.warn('Sum of BUDGET_PERCENTAGE and SUMMARY_BUDGET_PERCENTAGE exceeds 1');
  //   return false;
  // }
  
  // 检查计数配置
  if (config.THINKING_RECALL_COUNT < 0) {
    console.warn('THINKING_RECALL_COUNT should be non-negative');
    return false;
  }
  
  if (config.LARGE_SUMMARIZATION_WARNING_THRESHOLD < 0) {
    console.warn('LARGE_SUMMARIZATION_WARNING_THRESHOLD should be non-negative');
    return false;
  }
  
  return true;
}

/**
 * 获取可用Token预算的辅助函数
 * @param totalBudget 总预算（可选，使用默认值）
 * @returns 可用于上下文构建的Token数量
 */
export function getAvailableTokenBudget(totalBudget?: number): number {
  const budget = totalBudget || CONTEXT_BUILDER_CONFIG.DEFAULT_MAX_TOKENS;
  return Math.max(0, budget - CONTEXT_BUILDER_CONFIG.RESERVED_FOR_RESPONSE);
}

/**
 * 获取默认Token配置的辅助函数
 * @returns Token预算配置对象
 */
export function getDefaultTokenConfig(): {
  maxTokens: number;
  reservedForResponse: number;
  availableForContext: number;
} {
  const config = CONTEXT_BUILDER_CONFIG;
  return {
    maxTokens: config.DEFAULT_MAX_TOKENS,
    reservedForResponse: config.RESERVED_FOR_RESPONSE,
    availableForContext: getAvailableTokenBudget()
  };
}

/**
 * 检查Token预算是否充足的辅助函数
 * @param requiredTokens 需要的Token数量
 * @param totalBudget 总预算（可选，使用默认值）
 * @returns 是否有足够的Token预算
 */
export function hasEnoughTokenBudget(requiredTokens: number, totalBudget?: number): boolean {
  const availableBudget = getAvailableTokenBudget(totalBudget);
  return requiredTokens <= availableBudget;
}

/**
 * 获取推荐的摘要触发条件检查函数
 * @param currentTokenUsage 当前Token使用量
 * @param totalBudget 总预算
 * @param config 配置对象（可选，使用自适应配置）
 * @returns 是否应该触发摘要
 */
export function shouldTriggerSummarization(
  currentTokenUsage: number, 
  totalBudget: number, 
  config?: ContextBuilderConfig
): boolean {
  const activeConfig = config || CONTEXT_BUILDER_CONFIG;
  const threshold = totalBudget * activeConfig.SUMMARIZATION_TRIGGER_THRESHOLD;
  return currentTokenUsage >= threshold;
}