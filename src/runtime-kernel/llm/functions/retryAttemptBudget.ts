import type { LlmRetryConfig } from '../caller.types';
export const DEFAULT_LLM_MAX_TOTAL_ATTEMPTS = 8;

export interface LlmAttemptBudgetConfig {
  maxRetries: number;
  maxTotalAttempts?: number;
}

export function resolveLlmMaxTotalAttempts(config: LlmAttemptBudgetConfig): number {
  if (config.maxTotalAttempts === undefined) {
    return Math.max(DEFAULT_LLM_MAX_TOTAL_ATTEMPTS, config.maxRetries + 1);
  }

  if (!Number.isInteger(config.maxTotalAttempts) || config.maxTotalAttempts <= 0) {
    throw new Error('[LlmCaller] maxTotalAttempts must be a positive integer.');
  }

  return config.maxTotalAttempts;
}

export function hasLlmAttemptBudgetRemaining(params: {
  actualAttempts: number;
  maxTotalAttempts: number;
}): boolean {
  return params.actualAttempts < params.maxTotalAttempts;
}

/** 在进入真实请求前校验配置，避免 NaN/负数让计费调用绕过边界。 */
export function validateLlmRetryConfig(config: LlmRetryConfig): void {
  if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
    throw new Error('[LlmCaller] maxRetries must be a non-negative integer.');
  }
  if (!Number.isFinite(config.retryDelayMs) || config.retryDelayMs < 0) {
    throw new Error('[LlmCaller] retryDelayMs must be finite and non-negative.');
  }
  for (const [category, limit] of Object.entries(config.maxRetriesByCategory ?? {})) {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0 || limit > config.maxRetries)) {
      throw new Error(`[LlmCaller] maxRetriesByCategory.${category} must be an integer between 0 and maxRetries.`);
    }
  }
}
