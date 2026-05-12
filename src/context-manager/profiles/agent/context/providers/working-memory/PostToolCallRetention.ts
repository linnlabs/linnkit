import type { MessageProcessingState, ProviderContext } from '../base';
import {
  buildToolInteractionGroupsFromStates,
} from '../../../utils/toolInteractionGroup';
import type { ToolPairMatcher } from './ToolPairMatcher';
import type { ToolPairTruncator } from './ToolPairTruncator';
import type { ReplacementSourceTagger } from './ReplacementSourceTagger';
import type { DebugFn, WorkingMemoryRetentionResult } from './types';

/**
 * POST_TOOL_CALL 阶段的特殊保留策略。
 *
 * 中文备注：
 * - 工具刚执行完的下一 tick，最近工具组是模型续写最依赖的短期事实；
 * - 该策略先于常规 P1/P2/P3 执行，并通过 processedIds 防止后续重复计数。
 */
export function promoteMostRecentToolPair(params: {
  allStates: MessageProcessingState[];
  processedIds: Set<string>;
  currentTokens: number;
  budgetLimit: number;
  estimateTokens: ProviderContext['estimateTokens'];
  matcher: ToolPairMatcher;
  truncator: ToolPairTruncator;
  tagger: ReplacementSourceTagger;
  debug: DebugFn;
}): WorkingMemoryRetentionResult {
  const {
    allStates,
    processedIds,
    currentTokens,
    budgetLimit,
    estimateTokens,
    matcher,
    truncator,
    tagger,
    debug,
  } = params;
  let tokensUsed = 0;
  let processedCount = 0;
  const strategiesApplied: string[] = [];
  const toolGroups = buildToolInteractionGroupsFromStates(allStates);
  const group = [...toolGroups].reverse().find((candidate) => candidate.isComplete);
  if (!group || processedIds.has(group.anchorId)) {
    return { tokensUsed, processedCount, strategiesApplied };
  }

  tagger.tagReplacementSources(group.messages, allStates);

  const fit = matcher.canFitToolPair(group, currentTokens, budgetLimit, debug);
  if (fit.canFit) {
    for (const state of fit.pair) {
      if (state.action === 'skip') {
        state.action = 'keep_working_memory';
        state.phase = 'WORKING_MEMORY';
        tokensUsed += state.tokens;
        processedCount++;
      }
      processedIds.add(state.message.id);
    }
    strategiesApplied.push('post_tool_call_priority');
    debug('✅ POST_TOOL_CALL：优先保留最近工具交互对', { pairTokens: fit.totalTokens });
    return { tokensUsed, processedCount, strategiesApplied };
  }

  const truncated = truncator.truncate(group, estimateTokens, debug);
  if (!truncated.success) {
    return { tokensUsed, processedCount, strategiesApplied };
  }

  const fitAfterTruncation = matcher.canFitToolPair(group, currentTokens, budgetLimit, debug);
  if (!fitAfterTruncation.canFit) {
    return { tokensUsed, processedCount, strategiesApplied };
  }

  for (const state of fitAfterTruncation.pair) {
    if (state.action === 'skip') {
      state.action = 'keep_working_memory';
      state.phase = 'WORKING_MEMORY';
      tokensUsed += state.tokens;
      processedCount++;
    }
    processedIds.add(state.message.id);
  }
  strategiesApplied.push('post_tool_call_truncation');
  debug('✅ POST_TOOL_CALL：截断后优先保留最近工具交互对', {
    pairTokens: fitAfterTruncation.totalTokens,
  });

  return { tokensUsed, processedCount, strategiesApplied };
}
