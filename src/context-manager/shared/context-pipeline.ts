import type {
  MessageProcessingState,
  ProviderContext,
} from './providers/base';
import {
  SUMMARIZATION_FAILED_ERROR_CODE,
  isContextProviderError,
} from './providers/base';
import type { ContextProviderRegistry } from './providers/registry';
import type { AiMessage, RuntimeEvent } from '../../contracts';

export interface ContextPipelineStats<TPhase extends PropertyKey> {
  phaseTiming: Record<TPhase, number>;
  phaseTokenUsage: Record<TPhase, { used: number; percentage: number }>;
  messageStats: {
    original: number;
    afterCoreContext: number;
    afterWorkingMemory: number;
    afterSummarization: number;
  };
}

export interface RunContextPipelineOptions<
  TConfig,
  TContext extends ProviderContext<TConfig>,
  TPhase extends PropertyKey,
  TStats extends ContextPipelineStats<TPhase>,
> {
  messages: AiMessage[];
  totalBudget: number;
  buildStats: TStats;
  providerRegistry: ContextProviderRegistry<TConfig>;
  providerContext: TContext;
  estimateTokens: (message: AiMessage) => number;
  getPhaseByProviderName: (providerName: string) => TPhase | null;
  debug?: (message: string, data?: Record<string, unknown>) => void;
}

export interface RunContextPipelineResult {
  finalMessages: AiMessage[];
  finalTokens: number;
  strategiesApplied: string[];
  events: RuntimeEvent[];
}

export async function runContextPipeline<
  TConfig,
  TContext extends ProviderContext<TConfig>,
  TPhase extends PropertyKey,
  TStats extends ContextPipelineStats<TPhase>,
>(options: RunContextPipelineOptions<TConfig, TContext, TPhase, TStats>): Promise<RunContextPipelineResult> {
  const {
    messages,
    totalBudget,
    buildStats,
    providerRegistry,
    providerContext,
    estimateTokens,
    getPhaseByProviderName,
    debug,
  } = options;

  let states: MessageProcessingState[] = messages.map((message, index) => ({
    message,
    originalIndex: index,
    action: 'skip',
    tokens: estimateTokens(message),
  }));

  const providers = providerRegistry.getAllProviders();
  let availableBudget = totalBudget;
  const allStrategiesApplied: string[] = [];
  const allEvents: RuntimeEvent[] = [];

  debug?.('🎯 [ContextPipeline] 开始 Provider 链式处理', {
    totalProviders: providers.length,
    providerOrder: providers.map(provider => `${provider.name}(优先级:${provider.priority})`),
  });

  for (const provider of providers) {
    const phaseStartTime = performance.now();

    if (provider.shouldSkip?.(states, availableBudget, providerContext)) {
      debug?.(`⏭️ 跳过Provider: ${provider.name}`, { availableBudget });
      continue;
    }

    debug?.(`🔄 执行Provider: ${provider.name}`, { availableBudget });

    try {
      const result = await provider.provide(states, availableBudget, providerContext);

      states = result.states;

      if (result.events && result.events.length > 0) {
        allEvents.push(...result.events);
        debug?.('📦 收集到事件', {
          provider: provider.name,
          eventCount: result.events.length,
          eventTypes: result.events.map(event => event.type),
        });
      }

      availableBudget -= result.tokensUsed;
      allStrategiesApplied.push(...result.strategiesApplied);

      const phaseName = getPhaseByProviderName(provider.name);
      if (phaseName !== null) {
        buildStats.phaseTiming[phaseName] = performance.now() - phaseStartTime;
        buildStats.phaseTokenUsage[phaseName] = {
          used: result.tokensUsed,
          percentage: (result.tokensUsed / totalBudget) * 100,
        };
      }

      debug?.(`✅ Provider完成: ${provider.name}`, {
        tokensUsed: result.tokensUsed,
        remainingBudget: availableBudget,
        processedCount: result.stats.processedCount,
        strategiesApplied: result.strategiesApplied,
      });
    } catch (error) {
      debug?.(`❌ Provider失败: ${provider.name}`, { error });

      if (isFatalProviderError(error)) {
        throw error;
      }
    }
  }

  buildStats.messageStats.afterCoreContext = states.filter(state => state.action === 'keep_core').length;
  buildStats.messageStats.afterWorkingMemory = states.filter(state => state.action.startsWith('keep_')).length;
  buildStats.messageStats.afterSummarization = states.filter(state => state.action !== 'skip').length;

  const finalMessages = generateFinalMessages(states);
  const finalTokens = finalMessages.reduce((total, message) => total + estimateTokens(message), 0);

  return {
    finalMessages,
    finalTokens,
    strategiesApplied: [...new Set(allStrategiesApplied)],
    events: allEvents,
  };
}

export function generateFinalMessages(states: MessageProcessingState[]): AiMessage[] {
  const sysPromptMessages: MessageProcessingState[] = [];
  const summaryMessages: MessageProcessingState[] = [];
  const otherMessages: MessageProcessingState[] = [];

  for (const state of states) {
    if (!state.action.startsWith('keep_')) {
      continue;
    }

    if (state.message.type === 'system_prompt') {
      sysPromptMessages.push(state);
    } else if (state.message.type === 'history_summary') {
      summaryMessages.push(state);
    } else {
      otherMessages.push(state);
    }
  }

  sysPromptMessages.sort((a, b) => a.originalIndex - b.originalIndex);
  summaryMessages.sort((a, b) => a.originalIndex - b.originalIndex);
  otherMessages.sort((a, b) => a.originalIndex - b.originalIndex);

  const finalStates: MessageProcessingState[] = [
    ...sysPromptMessages,
    ...summaryMessages,
    ...otherMessages,
  ];

  return finalStates.map(state => {
    const { id, role, type, timestamp, metadata } = state.message;
    return {
      id,
      role,
      type,
      content: state.processedContent || state.message.content,
      timestamp,
      ...(metadata && { metadata }),
    } as AiMessage;
  });
}

function isFatalProviderError(error: unknown): boolean {
  return (
    isContextProviderError(error) &&
    error.code === SUMMARIZATION_FAILED_ERROR_CODE &&
    error.fatal === true
  );
}
