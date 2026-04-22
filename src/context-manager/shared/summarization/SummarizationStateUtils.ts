import type { MessageProcessingState, ProviderContext } from '../providers/base';
import { generateMessageId } from '../../../shared/ids';
import {
  createHistorySummaryEvent,
  type AiMessage,
  type RuntimeEvent,
} from '../../../contracts';

export type ReplacedIdRange = {
  startId: string;
  endId: string;
};

export class SummarizationStateUtils {
  static collectReplacedIds(candidates: MessageProcessingState[]): string[] {
    const allReplacedIds = new Set<string>();
    for (const candidate of candidates) {
      allReplacedIds.add(candidate.message.id);
      if (Array.isArray(candidate.replacementSourceIds)) {
        for (const sourceId of candidate.replacementSourceIds) {
          allReplacedIds.add(sourceId);
        }
      }
      const metadataSources = candidate.message.metadata?.replacementSourceIds;
      if (Array.isArray(metadataSources)) {
        for (const sourceId of metadataSources) {
          allReplacedIds.add(sourceId);
        }
      }
      if (candidate.message.type === 'history_summary' && candidate.message.metadata?.replacedMessageIds) {
        for (const oldId of candidate.message.metadata.replacedMessageIds) {
          allReplacedIds.add(oldId);
        }
      }
    }
    return Array.from(allReplacedIds);
  }

  static generateSummarySeq(allMessages: AiMessage[]): number {
    let seq = 0;
    for (const msg of allMessages) {
      if (msg.type === 'history_summary') {
        seq = Math.max(seq, msg.metadata?.summarySeq || 0);
      }
    }
    return seq + 1;
  }

  static createSummaryMessageState(
    summary: string,
    candidates: MessageProcessingState[],
    context: ProviderContext,
    allMessages: AiMessage[],
    includedOldSummary: boolean = false
  ): { state: MessageProcessingState; event: RuntimeEvent } {
    const summaryId = generateMessageId();
    const timestamp = Date.now();
    const replacedMessageIds = this.collectReplacedIds(candidates);
    const originalMessageCount = candidates.length;
    const summarySeq = this.generateSummarySeq(allMessages);

    const description = includedOldSummary
      ? `[历史对话摘要(更新版) - 合并压缩了${originalMessageCount}条消息，包括旧摘要]`
      : `[历史对话摘要 - 压缩了${originalMessageCount}条消息]`;
    const fullContent = `${description}\n\n${summary}`;

    const summaryMessage: AiMessage = {
      id: summaryId,
      role: 'system',
      type: 'history_summary',
      content: fullContent,
      timestamp,
      metadata: {
        messageType: 'summary',
        originalMessageCount,
        compressionRatio: 0,
        includedOldSummary,
        replacedMessageIds,
        summarySeq,
      },
    };

    const tokens = context.estimateTokens(summaryMessage);
    if (summaryMessage.metadata) {
      const originalTokens = this.calculateOriginalTokens(candidates);
      summaryMessage.metadata.compressionRatio = originalTokens > 0 ? tokens / originalTokens : 0;
    }

    const summaryState: MessageProcessingState = {
      message: summaryMessage,
      originalIndex: -1,
      action: 'keep_core' as const,
      tokens,
      processedContent: summaryMessage.content,
      contentType: 'full' as const,
      phase: 'SUMMARIZATION' as const,
    };

    const summaryEvent = createHistorySummaryEvent(
      summaryId,
      '',
      '',
      fullContent,
      replacedMessageIds,
      summarySeq,
      {
        timestamp,
        original_message_count: originalMessageCount,
        compression_ratio: summaryMessage.metadata?.compressionRatio,
        included_old_summary: includedOldSummary,
      }
    );

    return { state: summaryState, event: summaryEvent };
  }

  static replaceWithSummary(
    allStates: MessageProcessingState[],
    candidatesForSummarization: MessageProcessingState[],
    summaryState: MessageProcessingState
  ): MessageProcessingState[] {
    const remainingStates = allStates.filter((s) => !candidatesForSummarization.includes(s));
    const insertIndex = Math.min(3, remainingStates.length);
    return [
      ...remainingStates.slice(0, insertIndex),
      summaryState,
      ...remainingStates.slice(insertIndex),
    ];
  }

  static calculateOriginalTokens(candidates: MessageProcessingState[]): number {
    return candidates.reduce((total, state) => total + state.tokens, 0);
  }
}
