import type { MessageProcessingState, ProviderContext } from '../base';
import type { ToolInteractionGroup } from '../../../utils/toolInteractionGroup';
import type { ToolPairMatcher } from './ToolPairMatcher';
import type { ToolPairTruncator } from './ToolPairTruncator';
import type { DebugFn } from './types';

/**
 * 工具组保留原语。
 *
 * 中文备注：
 * - P1、P3 都要保证 tool_call 与 tool_output 成对保留；
 * - 这里集中处理“直接装入 / 截断后装入 / 截断后仍超限”的协议细节。
 */
export function keepToolGroup(params: {
  group: ToolInteractionGroup<MessageProcessingState>;
  processedIds: Set<string>;
  currentTokens: number;
  budgetLimit: number;
  estimateTokens: ProviderContext['estimateTokens'];
  matcher: ToolPairMatcher;
  truncator: ToolPairTruncator;
  debug: DebugFn;
  directStrategy: string;
  truncatedStrategy: string;
  directLog: string;
  truncatedLog: string;
  truncationFailedLog: string;
  stopWhenTruncatedDoesNotFit: boolean;
}): {
  tokensUsed: number;
  processedCount: number;
  strategiesApplied: string[];
  kept: boolean;
  stop: boolean;
} {
  const {
    group,
    processedIds,
    currentTokens,
    budgetLimit,
    estimateTokens,
    matcher,
    truncator,
    debug,
  } = params;
  let tokensUsed = 0;
  let processedCount = 0;
  const strategiesApplied: string[] = [];

  const fit = matcher.canFitToolPair(group, currentTokens, budgetLimit, debug);
  if (fit.canFit) {
    for (const pairState of fit.pair) {
      if (pairState.action === 'skip') {
        markWorkingMemory(pairState);
        tokensUsed += pairState.tokens;
        processedCount++;
      }
      processedIds.add(pairState.message.id);
    }
    strategiesApplied.push(params.directStrategy);
    debug(params.directLog, {
      anchorId: group.anchorId,
      pairSize: fit.pair.length,
      tokens: fit.totalTokens,
    });
    return { tokensUsed, processedCount, strategiesApplied, kept: true, stop: false };
  }

  const truncationResult = truncator.truncate(group, estimateTokens, debug);
  if (!truncationResult.success) {
    debug(params.truncationFailedLog, {
      anchorId: group.anchorId,
      pairSize: group.messages.length,
      tokens: group.messages.reduce((sum, state) => sum + state.tokens, 0),
    });
    return { tokensUsed, processedCount, strategiesApplied, kept: false, stop: false };
  }

  const fitAfterTruncation = matcher.canFitToolPair(group, currentTokens, budgetLimit, debug);
  if (!fitAfterTruncation.canFit) {
    if (params.stopWhenTruncatedDoesNotFit) {
      debug('💰 截断后仍无法装入预算，停止继续保留更旧工具对（保持结构一致）', {
        pairTokens: fitAfterTruncation.totalTokens,
        budgetLimit,
      });
    }
    return {
      tokensUsed,
      processedCount,
      strategiesApplied,
      kept: false,
      stop: params.stopWhenTruncatedDoesNotFit,
    };
  }

  for (const pairState of fitAfterTruncation.pair) {
    if (pairState.action === 'skip') {
      markWorkingMemory(pairState);
      tokensUsed += pairState.tokens;
      processedCount++;
    }
    processedIds.add(pairState.message.id);
  }
  strategiesApplied.push(params.truncatedStrategy);
  debug(params.truncatedLog, {
    anchorId: group.anchorId,
    pairSize: fitAfterTruncation.pair.length,
    tokens: fitAfterTruncation.totalTokens,
    truncatedTokens: truncationResult.tokensSaved,
  });
  return { tokensUsed, processedCount, strategiesApplied, kept: true, stop: false };
}

export function markWorkingMemory(state: MessageProcessingState): void {
  state.action = 'keep_working_memory';
  state.phase = 'WORKING_MEMORY';
}
