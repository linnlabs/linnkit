import type { MessageProcessingState, ProviderContext } from '../base';
import type { ToolInteractionGroup } from '../../../utils/toolInteractionGroup';
import type { ToolPairMatcher } from './ToolPairMatcher';
import type { ToolPairTruncator } from './ToolPairTruncator';
import type { ReplacementSourceTagger } from './ReplacementSourceTagger';
import { keepToolGroup } from './ToolGroupKeeper';
import type { DebugFn, ToolInteractionRetentionResult } from './types';

/**
 * P1：当前轮工具交互保留。
 *
 * 中文备注：
 * - 当前轮工具组优先保留，不受“历史工具组数量”上限影响；
 * - 历史工具组只在 P1 中保留最近 N 组，剩余交给 P3 统一处理。
 */
export function processToolInteractions(params: {
  allStates: MessageProcessingState[];
  toolGroups: ToolInteractionGroup<MessageProcessingState>[];
  processedIds: Set<string>;
  currentTokens: number;
  budgetLimit: number;
  estimateTokens: ProviderContext['estimateTokens'];
  maxToolPairsToKeep: number;
  minToolPairsToKeep: number;
  lastUserOriginalIndex: number | null;
  matcher: ToolPairMatcher;
  truncator: ToolPairTruncator;
  tagger: ReplacementSourceTagger;
  debug: DebugFn;
}): ToolInteractionRetentionResult {
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
  let historicalToolGroupsKept = 0;
  const maxToolPairsToKeep = Math.max(0, Math.floor(params.maxToolPairsToKeep));
  const minToolPairsToKeep = Math.min(
    maxToolPairsToKeep,
    Math.max(0, Math.floor(params.minToolPairsToKeep)),
  );
  const lastUserOriginalIndex = params.lastUserOriginalIndex;

  for (let index = toolGroups.length - 1; index >= 0; index -= 1) {
    const group = toolGroups[index];
    const isInCurrentTurn =
      lastUserOriginalIndex === null
        ? true
        : group.startIndex > lastUserOriginalIndex;

    if (!isInCurrentTurn && historicalToolGroupsKept >= maxToolPairsToKeep) {
      break;
    }

    const shouldForceKeepForMinimum = historicalToolGroupsKept < minToolPairsToKeep;
    if (!shouldForceKeepForMinimum && currentTokens + tokensUsed >= budgetLimit) {
      debug('💰 达到预算限制，停止工具交互填充', {
        currentTokens: currentTokens + tokensUsed,
        budgetLimit,
      });
      break;
    }

    if (processedIds.has(group.anchorId)) {
      continue;
    }

    if (!group.isComplete) {
      debug('⚠️ 跳过不完整工具组，避免破坏协议顺序', {
        anchorId: group.anchorId,
        toolCallIds: group.toolCallIds,
      });
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
      directStrategy: 'tool_interaction_pairing',
      truncatedStrategy: 'tool_interaction_truncation',
      directLog: '✅ P1保留工具交互对',
      truncatedLog: '✅ P1截断工具交互对',
      truncationFailedLog: '❌ P1截断工具交互对失败',
      stopWhenTruncatedDoesNotFit: true,
    });

    tokensUsed += kept.tokensUsed;
    processedCount += kept.processedCount;
    strategiesApplied.push(...kept.strategiesApplied);

    if (kept.stop) {
      break;
    }
    if (kept.kept && !isInCurrentTurn) {
      historicalToolGroupsKept++;
    }
  }

  return { tokensUsed, processedCount, strategiesApplied, historicalToolGroupsKept };
}
