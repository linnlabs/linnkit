import type { MessageProcessingState } from '../providers/base';
import { TokenCalculator } from '../../../shared/TokenCalculator';
import type { SummarizationProviderContext } from './config';

export class SummarizationTrigger {
  static shouldSkip(
    states: MessageProcessingState[],
    availableBudget: number,
    context: SummarizationProviderContext
  ): boolean {
    const usedTokens = this.calculateUsedTokens(states);
    const usagePercentage = usedTokens / availableBudget;
    return usagePercentage < context.config.SUMMARIZATION_TRIGGER_THRESHOLD;
  }

  static shouldTriggerSummarization(
    states: MessageProcessingState[],
    remainingBudget: number,
    totalBudget: number,
    context: SummarizationProviderContext,
    debugFn: (
      message: string,
      data: Record<string, unknown>,
      context: SummarizationProviderContext,
    ) => void,
  ): boolean {
    const usedTokensRough = this.calculateUsedTokens(states);
    const threshold = totalBudget * context.config.SUMMARIZATION_TRIGGER_THRESHOLD;
    const lowerBound = threshold * 0.9;
    if (usedTokensRough < lowerBound) {
      return false;
    }

    debugFn('📝 估算Token接近摘要阈值，切换到精确计算', {
      usedTokensRough,
      threshold,
    }, context);

    const messagesToKeep = states
      .filter((s) => s.action.startsWith('keep_'))
      .map((s) => s.message);
    const modelIdentifier = context.config.TOKEN_ENCODING_NAME;
    const usedTokensPrecise = messagesToKeep.reduce(
      (total, msg) => total + TokenCalculator.estimateTokensPrecise(msg.content, modelIdentifier),
      0
    );

    debugFn('📊 精确计算结果', {
      usedTokensPrecise,
      threshold,
      shouldTrigger: usedTokensPrecise >= threshold,
    }, context);

    return usedTokensPrecise >= threshold;
  }

  static calculateUsedTokens(states: MessageProcessingState[]): number {
    return states
      .filter((s) => s.action.startsWith('keep_'))
      .reduce((total, state) => total + state.tokens, 0);
  }
}
