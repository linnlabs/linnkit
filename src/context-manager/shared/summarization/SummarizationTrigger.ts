import type { MessageProcessingState } from '../providers/base';
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
    _remainingBudget: number,
    totalBudget: number,
    context: SummarizationProviderContext,
    debugFn: (
      message: string,
      data: Record<string, unknown>,
      context: SummarizationProviderContext,
    ) => void,
  ): boolean {
    const usedTokens = this.calculateUsedTokens(states);
    const threshold = totalBudget * context.config.SUMMARIZATION_TRIGGER_THRESHOLD;
    const lowerBound = threshold * 0.9;
    if (usedTokens < lowerBound) {
      return false;
    }

    // 中文备注：state.tokens 已由 ContextManagerBase 的 TokenizerPort + calibration 统一写入。
    // 这里不能再直接调用 TokenCalculator，否则 host 自定义 tokenizer 会在摘要触发分支失效。
    const shouldTrigger = usedTokens >= threshold;
    debugFn('📝 统一Token估算接近摘要阈值，检查是否触发摘要', {
      usedTokens,
      threshold,
      shouldTrigger,
    }, context);

    return shouldTrigger;
  }

  static calculateUsedTokens(states: MessageProcessingState[]): number {
    return states
      .filter((s) => s.action.startsWith('keep_'))
      .reduce((total, state) => total + state.tokens, 0);
  }
}
