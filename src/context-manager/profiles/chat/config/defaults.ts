/**
 * @file src/agent/context-manager/profiles/chat/config/defaults.ts
 * @description Chat Service 默认配置 - 统一配置来源
 * 
 * 🎯 目的: 避免配置重复，提供统一的默认值管理
 */

import type { OrchestratorOptions } from '../orchestration/MessageOrchestrator';

type OrchestratorBootstrapOptions = Pick<
  OrchestratorOptions,
  'tokenBudget' | 'processing' | 'model' | 'systemPrompt'
>;

/**
 * Chat Service 默认 Token 预算配置
 * 
 * 🔧 配置说明:
 * - maxTokens: 64000 - 适中的上下文窗口，兼容大多数模型
 * - reservedForResponse: 2000 - 为AI回复预留的token空间
 * - systemPromptTokens: 500 - 系统提示词的预估token数
 * - minimumHistoryMessages: 2 - 保证至少保留的历史消息数
 */
export const DEFAULT_TOKEN_BUDGET = {
  maxTokens: 64000,
  reservedForResponse: 2000,
  systemPromptTokens: 500,
  minimumHistoryMessages: 2
} as const;

/**
 * Chat Service 默认处理选项
 */
export const DEFAULT_PROCESSING_OPTIONS = {
  enableMerge: true,
  enableBatch: false, // 关闭批量处理，使用第1步的合并
  debugMode: false,
  preserveMetadata: true
} as const;

/**
 * MessageOrchestrator 完整默认配置
 */
export const DEFAULT_ORCHESTRATOR_OPTIONS: OrchestratorBootstrapOptions = {
  tokenBudget: DEFAULT_TOKEN_BUDGET,
  processing: DEFAULT_PROCESSING_OPTIONS,
  /**
   * Token 精确估算用的“模型标识”（用于映射到 tiktoken encoding）
   *
   * 说明：
   * - 这里只用于 TokenCalculator 的 encoding 选择，不用于真实 LLM 调用；
   * - 避免在这里写死任何业务模型 id（真实选模必须走 agent-registry + 前端主/辅模型策略）。
   */
  model: 'cl100k_base'
} as const;

/**
 * 创建自定义配置的辅助函数
 * 可以覆盖默认配置的任何部分
 */
export function createTokenBudgetConfig(overrides: Partial<typeof DEFAULT_TOKEN_BUDGET>) {
  return {
    ...DEFAULT_TOKEN_BUDGET,
    ...overrides
  };
}

/**
 * 环境相关的配置调整
 */
export function getEnvironmentConfig(): Partial<OrchestratorBootstrapOptions> {
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  return {
    processing: {
      ...DEFAULT_PROCESSING_OPTIONS,
      debugMode: isDevelopment
    }
  };
}
