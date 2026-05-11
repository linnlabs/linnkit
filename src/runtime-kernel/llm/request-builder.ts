import type { AgentAiEngine } from '../../ports';
import type { LlmRetryConfig } from './caller.types';
import type { LLMPolicyErrorDecision, LLMPolicyMatchContext } from './policies/types';
import type { ModelCatalogLike } from './modelCatalog';
import { ModelResolver, type ModelResolverLike } from './modelResolver';
import { defaultPolicyEngine } from './policies/defaultPolicyEngine';

export interface LlmCallerOptions {
  maxRetries?: number;
  enableEmptyResponseRetry?: boolean;
  retryDelayMs?: number;
  fallbackModelPreferredOrder?: readonly string[];
  modelResolver?: ModelResolverLike;
  modelCatalog?: ModelCatalogLike;
  policyEngine?: {
    decideOnError(error: Error, ctx: LLMPolicyMatchContext): LLMPolicyErrorDecision;
  };
  aiEngine: AgentAiEngine;
}

export interface NormalizedLlmCallerDeps {
  retryConfig: LlmRetryConfig;
  modelResolver: ModelResolverLike;
  policyEngine: NonNullable<LlmCallerOptions['policyEngine']>;
  aiEngine: AgentAiEngine;
}

export function isLlmCallerOptions(options: Partial<LlmRetryConfig> | LlmCallerOptions): options is LlmCallerOptions {
  return 'fallbackModelPreferredOrder' in options
    || 'modelResolver' in options
    || 'aiEngine' in options;
}

export const createMissingAiEngine = (): AgentAiEngine => ({
  async chatCompletion(): Promise<never> {
    throw new Error('[LlmCaller] aiEngine is required. Inject it from host assembly or test harness.');
  },
  async chatCompletionStream(): Promise<never> {
    throw new Error('[LlmCaller] aiEngine is required. Inject it from host assembly or test harness.');
  },
});

export function normalizeConstructorOptions(
  options?: Partial<LlmRetryConfig> | LlmCallerOptions,
): LlmCallerOptions {
  if (!options) {
    throw new Error('[LlmCaller] aiEngine is required. Inject it from host assembly or test harness.');
  }

  if (isLlmCallerOptions(options)) {
    return options;
  }

  return {
    ...options,
    aiEngine: createMissingAiEngine(),
  };
}

export function buildLlmCallerDeps(
  options: LlmCallerOptions,
  fallbackModelCatalog: ModelCatalogLike,
): NormalizedLlmCallerDeps {
  const modelCatalog = options.modelCatalog ?? fallbackModelCatalog;
  return {
    retryConfig: {
      maxRetries: options.maxRetries ?? 3,
      enableEmptyResponseRetry: options.enableEmptyResponseRetry ?? true,
      retryDelayMs: options.retryDelayMs ?? 1000,
    },
    modelResolver:
      options.modelResolver ??
      new ModelResolver({
        fallbackModelPreferredOrder: options.fallbackModelPreferredOrder,
        modelCatalog,
      }),
    policyEngine: options.policyEngine ?? defaultPolicyEngine,
    aiEngine: options.aiEngine,
  };
}
