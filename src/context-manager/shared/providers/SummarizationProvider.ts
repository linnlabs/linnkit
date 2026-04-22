/**
 * @file src/agent/context-manager/shared/providers/SummarizationProvider.ts
 * @description 统一摘要化处理层Provider - Chat 和 Agent 通用
 */

import {
  BaseContextProvider,
  ProviderResult,
  MessageProcessingState,
} from './base';
import {
  SummarizationTrigger,
  SummarizationCandidateSelector,
  AISummaryGenerator,
  SummarizationOptions,
  SummarizationStateUtils,
} from '../summarization';
import type { SummarizationConfig, SummarizationProviderContext } from '../summarization/config';

export type { SummarizationOptions } from '../summarization';

export class SummarizationProvider extends BaseContextProvider<SummarizationConfig> {
  readonly name = 'SummarizationProvider';
  readonly description = '摘要化处理层 - 核心对话压缩，聚焦用户意图与AI回答';
  readonly priority = 3;

  private aiGenerator: AISummaryGenerator;

  constructor(options: SummarizationOptions) {
    super();
    this.aiGenerator = new AISummaryGenerator(options);
  }

  async provide(
    states: MessageProcessingState[],
    availableBudget: number,
    context: SummarizationProviderContext
  ): Promise<ProviderResult> {
    const usedTokens = SummarizationTrigger.calculateUsedTokens(states);
    const remainingBudget = availableBudget - usedTokens;

    const shouldSummarize = SummarizationTrigger.shouldTriggerSummarization(
      states,
      remainingBudget,
      context.totalBudget,
      context,
      this.debug.bind(this)
    );

    if (!shouldSummarize) {
      return this.createResult(states, 0, [], {
        processedCount: 0,
        skippedCount: 0,
        addedCount: 0,
      });
    }

    const workingMemoryStates = states.filter((s) => s.action.startsWith('keep_working') || s.action.startsWith('keep_'));

    console.log('[AgentSummarizationProvider] 📊 工作记忆状态统计:', {
      总消息数: workingMemoryStates.length,
      消息类型分布: workingMemoryStates.reduce((acc, s) => {
        acc[s.message.type] = (acc[s.message.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });

    const { allCandidates: candidatesToReplace, coreCandidates: candidatesForPrompt } =
      SummarizationCandidateSelector.identifySummarizationCandidates(
        workingMemoryStates,
        context,
        { fullStateList: states }
      );

    console.log('[AgentSummarizationProvider] 🔥 步骤2完成 - 识别摘要候选:', {
      所有候选数: candidatesToReplace.length,
      核心候选数: candidatesForPrompt.length,
      所有候选类型分布: candidatesToReplace.reduce((acc, s) => {
        acc[s.message.type] = (acc[s.message.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      核心候选类型分布: candidatesForPrompt.reduce((acc, s) => {
        acc[s.message.type] = (acc[s.message.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      所有候选ID列表: candidatesToReplace.map((s) => `${s.message.type}:${s.message.id}`).slice(0, 5),
    });

    if (candidatesToReplace.length === 0 || candidatesForPrompt.length === 0) {
      return this.createResult(states, 0, [], {
        processedCount: 0,
        skippedCount: 0,
        addedCount: 0,
      });
    }

    context.summarizationCallbacks?.onSummarizationStart?.();

    try {
      const summaryResult = await this.aiGenerator.generateHistorySummary(
        candidatesForPrompt,
        context,
        this.debug.bind(this)
      );

      const includedOldSummary = candidatesToReplace.some(
        (candidate) => candidate.message.type === 'history_summary'
      );

      console.log('[AgentSummarizationProvider] 🔥 步骤4完成 - 准备创建摘要消息:', {
        替换块消息数: candidatesToReplace.length,
        包含旧摘要: includedOldSummary,
      });

      const allMessages = states.map((s) => s.message);
      const { state: summaryState, event: summaryEvent } = SummarizationStateUtils.createSummaryMessageState(
        summaryResult,
        candidatesToReplace,
        context,
        allMessages,
        includedOldSummary
      );

      const updatedStates = SummarizationStateUtils.replaceWithSummary(states, candidatesToReplace, summaryState);
      const tokensUsed = summaryState.tokens;

      context.summarizationCallbacks?.onSummarizationEnd?.({
        originalMessageCount: candidatesToReplace.length,
        summaryEvent,
      });

      this.debug('✨ 摘要化处理完成', {
        originalMessages: candidatesToReplace.length,
        summaryTokens: tokensUsed,
        compressionRatio: `${((tokensUsed / SummarizationStateUtils.calculateOriginalTokens(candidatesToReplace)) * 100).toFixed(1)}%`,
        remainingBudget: availableBudget - usedTokens - tokensUsed,
      }, context);

      return this.createResult(
        updatedStates,
        tokensUsed,
        ['ai_history_summarization'],
        {
          processedCount: candidatesToReplace.length,
          skippedCount: 0,
          addedCount: 1,
        },
        [summaryEvent]
      );
    } catch (error) {
      this.debug('❌ 摘要化处理失败', { error }, context);

      if (context.summarizationCallbacks?.onSummarizationError) {
        const err = error instanceof Error ? error : new Error(String(error));
        context.summarizationCallbacks.onSummarizationError(err);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`历史对话摘要失败，无法继续: ${errorMessage}`);
    }
  }

  shouldSkip(
    states: MessageProcessingState[],
    availableBudget: number,
    context: SummarizationProviderContext
  ): boolean {
    return SummarizationTrigger.shouldSkip(states, availableBudget, context);
  }
}
