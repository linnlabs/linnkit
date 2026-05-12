import type { AnyAgentEvent, ErrorEvent as AgentErrorEvent } from '../events/agentEvents';
import { generateMessageId } from '../../shared/ids';
import { ErrorClassifier, ErrorCategory } from '../../shared/errorClassifier';
import type { AgentAiEngine } from '../../ports';
import type { LlmCallOptions, LlmRequestMessage, LlmRetryConfig } from './caller.types';
import type { LLMPolicyErrorDecision, LLMPolicyMatchContext } from './policies/types';
import type { ModelCatalogLike } from './modelCatalog';
import type { ModelResolverLike } from './modelResolver';
import { tryCloudQuotaFallback, tryPolicyModelSwitch } from './retry-fallback-routing';
import { callLlmStream } from './streaming-adapter';
import {
  callPlainCompletion,
  getLlmResultContent,
  getLlmResultToolCalls,
  type LlmCallResult,
} from './usage-telemetry';

export interface RetryFallbackDeps {
  retryConfig: LlmRetryConfig;
  modelResolver: ModelResolverLike;
  modelCatalog: ModelCatalogLike;
  policyEngine: {
    decideOnError(error: Error, ctx: LLMPolicyMatchContext): LLMPolicyErrorDecision;
  };
  aiEngine: AgentAiEngine;
}

export interface CallWithRetriesParams {
  deps: RetryFallbackDeps;
  modelId: string;
  messages: LlmRequestMessage[];
  options?: LlmCallOptions;
  eventHandler?: (event: AnyAgentEvent) => void;
  signal?: AbortSignal;
  onCloudQuotaFallbackApplied?: (fallbackModelId: string) => void;
  onModelFallbackApplied?: (info: {
    fromModelId: string;
    toModelId: string;
    reason: string;
    policy: 'policy-switch' | 'cloud-quota';
  }) => void;
}

export async function callWithRetryFallback(params: CallWithRetriesParams): Promise<LlmCallResult> {
  const {
    deps,
    modelId,
    messages,
    options = {},
    eventHandler,
    signal,
    onCloudQuotaFallbackApplied,
    onModelFallbackApplied,
  } = params;

  let lastError: Error | null = null;
  let actualAttempts = 0;
  let activeModelId = modelId;
  const excludedModelIds = new Set<string>([modelId]);
  const clientRetryEnabled = isClientRetryEnabledForModel(deps.modelCatalog, modelId, options);
  const configuredMaxRetries = deps.retryConfig.maxRetries;

  if (!clientRetryEnabled) {
    const activeCfg = deps.modelCatalog.getModelById(modelId);
    console.log('[LlmCaller] 🧾 默认禁用客户端重试（除非遇到本地纯网络错误）', {
      modelId,
      billing_mode: activeCfg?.billing_mode,
      reason: options.retry_policy === 'none' ? 'options.retry_policy=none' : 'model config (cloud billing or enable_client_retry=false)',
    });
  }

  for (let attempt = 0; attempt <= configuredMaxRetries; attempt++) {
    throwIfAborted(signal, '检测到取消信号，停止AI活动');

    const isRetry = attempt > 0;
    let pendingErrorEvent: AgentErrorEvent | null = null;
    const wrappedEventHandler = eventHandler
      ? createRetryAwareEventHandler(eventHandler, (evt) => {
          pendingErrorEvent = evt;
        }, attempt, () => activeModelId)
      : undefined;

    try {
      if (isRetry) {
        console.log(`[LlmCaller] 🔄 LLM调用 - 第 ${attempt} 次重试 (最大配置 ${configuredMaxRetries} 次)`);
      }

      actualAttempts++;
      const llmResponse = wrappedEventHandler
        ? await callLlmStream({
            aiEngine: deps.aiEngine,
            modelId: activeModelId,
            messages,
            options,
            eventHandler: wrappedEventHandler,
            signal,
          })
        : await callPlainCompletion(deps.aiEngine, activeModelId, messages, options, signal);

      const responseContent = getLlmResultContent(llmResponse);
      const toolCallsFromLLM = getLlmResultToolCalls(llmResponse);
      if (deps.retryConfig.enableEmptyResponseRetry && !responseContent?.trim() && !toolCallsFromLLM?.length) {
        throw new Error('LLM返回了空响应');
      }

      console.log(`[LlmCaller] ✅ LLM调用成功 (尝试 ${actualAttempts} 次)`);
      return llmResponse;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const classification = ErrorClassifier.classify(lastError, { logPrefix: '[LlmCaller]' });
      let currentMaxRetries = clientRetryEnabled ? configuredMaxRetries : 0;

      if (!clientRetryEnabled && classification.category === ErrorCategory.RETRYABLE) {
        if (
          classification.reason.startsWith('网络错误') ||
          classification.reason === '空响应错误' ||
          classification.reason === '模型输出损坏: invalid tool_call.arguments'
        ) {
          console.log(`[LlmCaller] 🛟 云端模型检测到必须本地兜底的错误 (${classification.reason})，破例允许客户端重试`);
          currentMaxRetries = configuredMaxRetries;
        }
      }

      console.error(`[LlmCaller] ❌ LLM调用失败 (尝试 ${attempt + 1}/${currentMaxRetries + 1}):`, lastError.message);

      if (lastError.name === 'AbortError') {
        console.log('[LlmCaller] 🛑 收到 AbortError，直接向上抛出，不进入错误事件与重试流程');
        throw lastError;
      }

      const policySwitchModelId = tryPolicyModelSwitch(deps, activeModelId, excludedModelIds, lastError);
      if (policySwitchModelId) {
        onModelFallbackApplied?.({
          fromModelId: activeModelId,
          toModelId: policySwitchModelId,
          reason: lastError.message,
          policy: 'policy-switch',
        });
        activeModelId = policySwitchModelId;
        excludedModelIds.add(policySwitchModelId);
        attempt -= 1;
        continue;
      }

      const quotaFallbackModelId = tryCloudQuotaFallback({
        deps,
        activeModelId,
        options,
        excludedModelIds,
        error: lastError,
        onCloudQuotaFallbackApplied,
      });
      if (quotaFallbackModelId) {
        onModelFallbackApplied?.({
          fromModelId: activeModelId,
          toModelId: quotaFallbackModelId,
          reason: lastError.message,
          policy: 'cloud-quota',
        });
        activeModelId = quotaFallbackModelId;
        excludedModelIds.add(quotaFallbackModelId);
        attempt -= 1;
        continue;
      }

      if (classification.category === ErrorCategory.NON_RETRYABLE) {
        console.error(`[LlmCaller] 💥 错误不可重试，直接失败: ${classification.reason}`);
        emitFinalError(eventHandler, pendingErrorEvent, lastError);
        throw lastError;
      }

      if (attempt >= currentMaxRetries) {
        console.error(`[LlmCaller] 💥 已达到最大重试次数 (${currentMaxRetries})，放弃重试`);
        emitFinalError(eventHandler, pendingErrorEvent, lastError);
        throw lastError;
      }

      const retryDelay = ErrorClassifier.calculateRetryDelay(
        lastError,
        attempt,
        deps.retryConfig.retryDelayMs,
        60000,
      );
      if (classification.category === ErrorCategory.RATE_LIMIT) {
        console.log(`[LlmCaller] ⏱️ 速率限制错误，延迟 ${retryDelay}ms 后重试 (${classification.reason})`);
      } else if (classification.category === ErrorCategory.RETRYABLE) {
        console.log(`[LlmCaller] 🔄 可重试错误，延迟 ${retryDelay}ms 后重试 (${classification.reason})`);
      }

      throwIfAborted(signal, '延迟等待前检测到取消信号，停止重试');
      if (retryDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw lastError || new Error('LLM调用在所有重试后都失败了');
}

function isClientRetryEnabledForModel(
  modelCatalog: ModelCatalogLike,
  modelId: string,
  options: LlmCallOptions,
): boolean {
  if (options.retry_policy === 'none') return false;
  if (options.retry_policy === 'client') return true;

  const cfg = modelCatalog.getModelById(modelId);
  if (!cfg) return true;
  if (cfg.billing_mode === 'cloud') {
    return cfg.enable_client_retry === true;
  }
  if (cfg.enable_client_retry === false) return false;
  return true;
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  console.log(`[LlmCaller] 🛑 ${message}`);
  const cancelError = new Error('Request cancelled by user');
  cancelError.name = 'AbortError';
  throw cancelError;
}

function createRetryAwareEventHandler(
  eventHandler: (event: AnyAgentEvent) => void,
  setPendingErrorEvent: (event: AgentErrorEvent) => void,
  attempt: number,
  getActiveModelId: () => string,
): (event: AnyAgentEvent) => void {
  return (evt: AnyAgentEvent) => {
    if (evt && typeof evt === 'object' && evt.type === 'error') {
      setPendingErrorEvent(evt);
      if (process.env.NODE_ENV !== 'production') {
        const rec = evt as { id?: unknown; error?: unknown; timestamp?: unknown };
        console.warn('[LlmCaller][callWithRetries] captured pending error event (will only forward if final failure)', {
          attempt,
          modelId: getActiveModelId(),
          eventId: typeof rec.id === 'string' ? rec.id : undefined,
          error: typeof rec.error === 'string' ? rec.error : undefined,
          timestamp: typeof rec.timestamp === 'number' ? rec.timestamp : undefined,
        });
      }
      return;
    }
    eventHandler(evt);
  };
}

function emitFinalError(
  eventHandler: ((event: AnyAgentEvent) => void) | undefined,
  pendingErrorEvent: AgentErrorEvent | null,
  error: Error,
): void {
  if (!eventHandler) return;
  eventHandler(pendingErrorEvent ?? {
    type: 'error',
    id: generateMessageId(),
    timestamp: Date.now(),
    error: error.message,
    details: error.stack,
  });
}
