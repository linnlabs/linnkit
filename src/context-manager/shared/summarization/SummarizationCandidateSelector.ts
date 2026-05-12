import type { MessageProcessingState } from '../providers/base';
import type { SummarizationProviderContext } from './config';

export class SummarizationCandidateSelector {
  static identifySummarizationCandidates(
    workingMemoryStates: MessageProcessingState[],
    context: SummarizationProviderContext,
    options: { fullStateList?: MessageProcessingState[] } = {}
  ): {
    allCandidates: MessageProcessingState[];
    coreCandidates: MessageProcessingState[];
  } {
    const { fullStateList } = options;
    const isValuable = (state: MessageProcessingState) => {
      if (state.message.type === 'system_prompt' || state.message.type === 'context_injection') {
        return false;
      }
      return true;
    };

    const allScopeStates = fullStateList ?? workingMemoryStates;
    const allValuableMessages = allScopeStates.filter(isValuable);
    const workingValuableMessages = workingMemoryStates.filter(isValuable);
    const coreMessages = workingValuableMessages.filter((state) => {
      return state.message.type === 'user_input'
        || state.message.type === 'final_answer'
        || state.message.type === 'history_summary';
    });

    console.log('[SummarizationCandidateSelector] 🔍 筛选消息（两步）:', {
      输入消息数: workingMemoryStates.length,
      摘要范围候选: allValuableMessages.length,
      核心对话消息: coreMessages.length,
      所有消息类型分布: allValuableMessages.reduce((acc, s) => {
        acc[s.message.type] = (acc[s.message.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      核心消息类型分布: coreMessages.reduce((acc, s) => {
        acc[s.message.type] = (acc[s.message.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });

    if (coreMessages.length <= 4) {
      return { allCandidates: [], coreCandidates: [] };
    }

    const sortedCoreMessages = coreMessages.sort((a, b) => {
      if (a.message.type === 'history_summary' && b.message.type !== 'history_summary') {
        return -1;
      }
      if (b.message.type === 'history_summary' && a.message.type !== 'history_summary') {
        return 1;
      }
      return a.originalIndex - b.originalIndex;
    });

    const summarizationCount = Math.ceil(sortedCoreMessages.length * context.config.SUMMARY_OLDEST_MESSAGES_PERCENTAGE);
    const lastUserInputIndex = sortedCoreMessages.map((s) => s.message.type).lastIndexOf('user_input');
    const maxSummarizationCount = lastUserInputIndex >= 0
      ? lastUserInputIndex
      : Math.max(0, sortedCoreMessages.length - 2);
    const actualSummarizationCount = Math.min(summarizationCount, maxSummarizationCount);

    if (actualSummarizationCount <= 0) {
      return { allCandidates: [], coreCandidates: [] };
    }

    const coreCandidatesSlice = sortedCoreMessages.slice(0, actualSummarizationCount);
    const coreCandidatesForPrompt = this.selectCompleteConversationPairs(coreCandidatesSlice, workingMemoryStates);
    const coreIndices = coreCandidatesForPrompt.map((s) => s.originalIndex);
    const minIndex = Math.min(...coreIndices);
    const maxIndex = Math.max(...coreIndices);

    console.log('[SummarizationCandidateSelector] 📐 计算替换范围:', {
      核心候选数: coreCandidatesForPrompt.length,
      minIndex,
      maxIndex,
      范围大小: maxIndex - minIndex + 1,
    });

    const allCandidatesInRange = allValuableMessages.filter((state) => {
      return state.originalIndex >= minIndex && state.originalIndex <= maxIndex;
    });

    console.log('[SummarizationCandidateSelector] ✅ 最终候选消息:', {
      所有候选数: allCandidatesInRange.length,
      核心候选数: coreCandidatesForPrompt.length,
      所有候选类型: allCandidatesInRange.reduce((acc, s) => {
        acc[s.message.type] = (acc[s.message.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });

    return {
      allCandidates: allCandidatesInRange,
      coreCandidates: coreCandidatesForPrompt,
    };
  }

  static selectCompleteConversationPairs(
    candidates: MessageProcessingState[],
    workingSet: MessageProcessingState[]
  ): MessageProcessingState[] {
    const result: MessageProcessingState[] = [];
    let i = 0;

    while (i < candidates.length) {
      const current = candidates[i];
      if (current.message.type === 'history_summary') {
        result.push(current);
        i++;
        continue;
      }
      if (current.message.type === 'user_input') {
        result.push(current);
        if (i + 1 < candidates.length && candidates[i + 1].message.type === 'final_answer') {
          result.push(candidates[i + 1]);
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (current.message.type === 'final_answer') {
        result.push(current);
        i++;
        continue;
      }
      i++;
    }

    return result;
  }
}
