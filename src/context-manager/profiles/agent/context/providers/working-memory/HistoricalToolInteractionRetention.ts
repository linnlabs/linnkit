import type { MessageProcessingState, ProviderContext } from '../base';
import type { ToolInteractionGroup } from '../../../utils/toolInteractionGroup';
import type { ToolPairMatcher } from './ToolPairMatcher';
import type { ToolPairTruncator } from './ToolPairTruncator';
import type { ReplacementSourceTagger } from './ReplacementSourceTagger';
import { buildHistoricalToolCandidates } from './HistoricalToolCandidates';
import { keepToolGroup, markWorkingMemory } from './ToolGroupKeeper';
import type { DebugFn, HistoricalToolRetentionResult } from './types';

/**
 * P3：历史工具交互保留。
 *
 * 中文备注：
 * - compressed 工具摘要与 raw 工具组共享 maxToolGroupsToKeep；
 * - 这里只处理最后一条 user_input 之前的历史段。
 */
export function processHistoricalToolInteractions(params: {
  allStates: MessageProcessingState[];
  toolGroups: ToolInteractionGroup<MessageProcessingState>[];
  processedIds: Set<string>;
  currentTokens: number;
  budgetLimit: number;
  estimateTokens: ProviderContext['estimateTokens'];
  maxToolGroupsToKeep: number;
  minToolGroupsToKeep: number;
  alreadyKeptToolGroups: number;
  lastUserOriginalIndex: number;
  matcher: ToolPairMatcher;
  truncator: ToolPairTruncator;
  tagger: ReplacementSourceTagger;
  debug: DebugFn;
}): HistoricalToolRetentionResult {
  const {
    allStates,
    toolGroups,
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
  let toolGroupsKept = 0;
  const maxToolGroupsToKeep = Math.max(0, Math.floor(params.maxToolGroupsToKeep));
  const minToolGroupsToKeep = Math.min(
    params.alreadyKeptToolGroups + maxToolGroupsToKeep,
    Math.max(0, Math.floor(params.minToolGroupsToKeep)),
  );

  const candidates = buildHistoricalToolCandidates({
    allStates,
    toolGroups,
    lastUserOriginalIndex: params.lastUserOriginalIndex,
    matcher,
  });
  for (const candidate of candidates) {
    if (toolGroupsKept >= maxToolGroupsToKeep) {
      break;
    }

    const shouldForceKeepForMinimum = params.alreadyKeptToolGroups + toolGroupsKept < minToolGroupsToKeep;
    if (!shouldForceKeepForMinimum && currentTokens + tokensUsed >= budgetLimit) {
      debug('💰 达到预算限制，停止历史工具交互填充', {
        currentTokens: currentTokens + tokensUsed,
        budgetLimit,
      });
      break;
    }

    if (candidate.kind === 'compressed') {
      const state = candidate.state;
      if (processedIds.has(state.message.id) || state.action !== 'skip') {
        continue;
      }
      if (!shouldForceKeepForMinimum && currentTokens + tokensUsed + state.tokens > budgetLimit) {
        continue;
      }
      markWorkingMemory(state);
      tokensUsed += state.tokens;
      processedCount++;
      processedIds.add(state.message.id);
      toolGroupsKept++;
      strategiesApplied.push('compressed_tool_history');
      continue;
    }

    const group = candidate.group;
    if (processedIds.has(group.anchorId) || !group.isComplete) {
      continue;
    }

    tagger.tagReplacementSources(group.messages, allStates);
    const kept = keepToolGroup({
      group,
      processedIds,
      currentTokens: currentTokens + tokensUsed,
      budgetLimit: shouldForceKeepForMinimum ? Number.MAX_SAFE_INTEGER : budgetLimit,
      estimateTokens,
      matcher,
      truncator,
      debug,
      directStrategy: 'historical_tool_interaction',
      truncatedStrategy: 'historical_tool_interaction_truncation',
      directLog: '✅ P3保留历史工具交互',
      truncatedLog: '✅ P3截断历史工具交互对',
      truncationFailedLog: '❌ P3截断历史工具交互对失败',
      stopWhenTruncatedDoesNotFit: false,
    });

    tokensUsed += kept.tokensUsed;
    processedCount += kept.processedCount;
    strategiesApplied.push(...kept.strategiesApplied);
    if (kept.kept) {
      toolGroupsKept++;
    }
  }

  return { tokensUsed, processedCount, strategiesApplied, toolGroupsKept };
}
