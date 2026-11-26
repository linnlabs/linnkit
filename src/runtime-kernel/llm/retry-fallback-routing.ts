import { Logger } from '../../shared/logger';
import type { RetryFallbackDeps } from './retry-fallback';
import {
  evaluateModelInputCompatibility,
  type ModelInputRequirement,
} from './input-capabilities';
import type { LlmFallbackObserver } from './definitions/llmFallbackObserver';
import type { FallbackPromptCapacityAdmission } from './functions/evaluateFallbackPromptCapacity';

const logger = new Logger('LlmCaller');

export function tryPolicyModelSwitch(
  deps: RetryFallbackDeps,
  activeModelId: string,
  excludedModelIds: Set<string>,
  requirement: ModelInputRequirement,
  fallbackObserver: LlmFallbackObserver | undefined,
  error: Error,
  evaluateFallbackPromptCapacity?: (candidateModelId: string) => FallbackPromptCapacityAdmission,
): string | null {
  const activeModelConfig = deps.modelCatalog.getModelById(activeModelId);
  const policyDecision = deps.policyEngine.decideOnError(error, {
    modelId: activeModelId,
  });
  if (policyDecision.action !== 'switch_model') {
    return null;
  }

  let fallbackModelId = deps.modelResolver.pickFallbackChatModel(excludedModelIds, requirement);
  while (fallbackModelId && evaluateFallbackPromptCapacity) {
    const admission = evaluateFallbackPromptCapacity(fallbackModelId);
    if (admission.admitted) break;
    fallbackObserver?.onModelFallbackRejected?.({
      fromModelId: activeModelId,
      candidateModelId: fallbackModelId,
      policy: 'policy-switch',
      reason: admission.reason,
      requiredPlacements: requirement.placements,
    });
    excludedModelIds.add(fallbackModelId);
    fallbackModelId = deps.modelResolver.pickFallbackChatModel(excludedModelIds, requirement);
  }
  if (!fallbackModelId) {
    fallbackObserver?.onModelFallbackRejected?.({
      fromModelId: activeModelId,
      policy: 'policy-switch',
      reason: 'no_eligible_fallback_candidate',
      requiredPlacements: requirement.placements,
    });
    logger.warn('Policy要求切换模型，但未找到可用备用模型（可能未配置 API Key）');
    return null;
  }

  logger.warn('Policy 切换模型继续', {
    reason: policyDecision.reason,
    activeModelId,
    fallbackModelId,
  });
  return fallbackModelId;
}
