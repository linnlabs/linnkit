import { ErrorClassifier } from '../../shared/errorClassifier';
import type { LlmCallOptions } from './caller.types';
import type { RetryFallbackDeps } from './retry-fallback';

export function tryPolicyModelSwitch(
  deps: RetryFallbackDeps,
  activeModelId: string,
  excludedModelIds: Set<string>,
  error: Error,
): string | null {
  const activeModelConfig = deps.modelCatalog.getModelById(activeModelId);
  const policyDecision = deps.policyEngine.decideOnError(error, {
    modelId: activeModelId,
    apiBase: activeModelConfig?.api_base,
    requestModelName: activeModelConfig?.model_name,
  });
  if (policyDecision.action !== 'switch_model') {
    return null;
  }

  const fallbackModelId = deps.modelResolver.pickFallbackChatModel(excludedModelIds);
  if (!fallbackModelId) {
    console.warn('[LlmCaller] 🧭 Policy要求切换模型，但未找到可用备用模型（可能未配置 API Key）');
    return null;
  }

  console.warn(`[LlmCaller] 🧭 Policy(${policyDecision.reason})，切换模型继续: ${activeModelId} -> ${fallbackModelId}`);
  return fallbackModelId;
}

export function tryCloudQuotaFallback({
  deps,
  activeModelId,
  options,
  excludedModelIds,
  error,
  onCloudQuotaFallbackApplied,
}: {
  deps: RetryFallbackDeps;
  activeModelId: string;
  options: LlmCallOptions;
  excludedModelIds: Set<string>;
  error: Error;
  onCloudQuotaFallbackApplied?: (fallbackModelId: string) => void;
}): string | null {
  const fallbackModelId = options.cloud_quota_fallback_model_id;
  if (
    !fallbackModelId ||
    !ErrorClassifier.isCloudQuotaError(error) ||
    excludedModelIds.has(fallbackModelId)
  ) {
    return null;
  }

  const fallbackConfig = deps.modelCatalog.getModelById(fallbackModelId);
  if (!fallbackConfig?.api_key) {
    console.warn(`[LlmCaller] ☁️ 云端限额降级目标不可用: ${fallbackModelId}（未注册或缺少 API Key）`);
    return null;
  }

  console.warn(`[LlmCaller] ☁️ 云端限额降级（run 内续跑）: ${activeModelId} -> ${fallbackModelId}`, {
    reason: error.message,
  });
  onCloudQuotaFallbackApplied?.(fallbackModelId);
  return fallbackModelId;
}
