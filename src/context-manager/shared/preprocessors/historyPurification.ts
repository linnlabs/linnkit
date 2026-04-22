import {
  BasePreprocessor,
  type PreprocessorContext,
  type PreprocessorResult,
} from './base';
import type { AiMessage } from '../../../contracts';

export interface HistoryPurificationConfig {
  logPrefix?: string;
}

export class HistoryPurificationPreprocessor extends BasePreprocessor {
  readonly name = 'HistoryPurificationPreprocessor';
  readonly description = '基于摘要ID列表的历史净化处理器';
  readonly priority = 1;

  private logPrefix: string;

  constructor(config: HistoryPurificationConfig = {}) {
    super();
    this.logPrefix = config.logPrefix || 'HistoryPurification';
  }

  async process(messages: AiMessage[], context: PreprocessorContext): Promise<PreprocessorResult> {
    this.debug('🧹 开始历史净化处理', { 原始消息数: messages.length }, context);

    const cleanedMessages = this.cleanHistoryWithSummaryReplacement(messages, context);
    const removedCount = messages.length - cleanedMessages.length;
    const appliedStrategies = removedCount > 0 ? ['summary_replacement_cleanup'] : [];

    this.debug(
      '✅ 历史净化完成',
      {
        原始消息: messages.length,
        净化后消息: cleanedMessages.length,
        移除消息: removedCount,
      },
      context,
    );

    return this.createResult(messages, cleanedMessages, appliedStrategies, 0);
  }

  shouldSkip(messages: AiMessage[], context: PreprocessorContext): boolean {
    const hasSummaryMessages = messages.some((msg) => msg.type === 'history_summary');
    if (!hasSummaryMessages) {
      this.debug('⏭️ 无摘要消息，跳过历史净化', {}, context);
      return true;
    }
    return false;
  }

  private findLatestSummary(summaryMessages: AiMessage[]): AiMessage {
    return summaryMessages.reduce((latest, current) => {
      const latestSeq = latest.metadata?.summarySeq ?? -1;
      const currentSeq = current.metadata?.summarySeq ?? -1;
      return currentSeq > latestSeq ? current : latest;
    }, summaryMessages[0]);
  }

  private cleanHistoryWithSummaryReplacement(
    messages: AiMessage[],
    context: PreprocessorContext,
  ): AiMessage[] {
    const summaryMessages = messages.filter((m) => m.type === 'history_summary');

    console.log(`[${this.logPrefix}] 🧹 开始历史净化（基于ID列表）`);
    console.log(`[${this.logPrefix}] 📊 总消息数: ${messages.length}, 摘要消息数: ${summaryMessages.length}`);

    this.debug(
      '🧹 开始历史净化',
      {
        总消息数: messages.length,
        摘要消息数: summaryMessages.length,
      },
      context,
    );

    if (summaryMessages.length === 0) {
      console.log(`[${this.logPrefix}] ⚠️ 未发现摘要消息，但不应该跳过（shouldSkip没有触发？）`);
      this.debug('⚠️ 未发现摘要消息', {}, context);
      return messages;
    }

    const latestSummary = this.findLatestSummary(summaryMessages);

    console.log(`[${this.logPrefix}] 📋 最新摘要:`, {
      id: latestSummary.id,
      summarySeq: latestSummary.metadata?.summarySeq,
      hasReplacedIds: Array.isArray(latestSummary.metadata?.replacedMessageIds),
      replacedCount: latestSummary.metadata?.replacedMessageIds?.length || 0,
    });

    this.debug(
      '📋 最新摘要',
      {
        id: latestSummary.id,
        summarySeq: latestSummary.metadata?.summarySeq,
        hasReplacedIds: Array.isArray(latestSummary.metadata?.replacedMessageIds),
        replacedCount: latestSummary.metadata?.replacedMessageIds?.length || 0,
      },
      context,
    );

    if (!latestSummary?.metadata?.replacedMessageIds || latestSummary.metadata.replacedMessageIds.length === 0) {
      this.debug('⏭️ 最新摘要缺少 replacedMessageIds，跳过净化', { summaryId: latestSummary?.id }, context);
      return messages;
    }

    const idsToRemove = new Set(latestSummary.metadata.replacedMessageIds);

    const summariesInInput = messages.filter((m) => m.type === 'history_summary');
    console.log(`[${this.logPrefix}] 📥 收到的消息列表:`, {
      总消息数: messages.length,
      摘要消息数: summariesInInput.length,
      摘要ID列表: summariesInInput.map((s) => ({ id: s.id, seq: s.metadata?.summarySeq })),
      消息类型分布: messages.reduce((acc, m) => {
        acc[m.type] = (acc[m.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });

    const summaryIdsInRemoveList = summariesInInput.filter((s) => idsToRemove.has(s.id || ''));
    console.log(`[${this.logPrefix}] ⚠️ 摘要ID检查:`, {
      摘要是否在移除列表: summaryIdsInRemoveList.length > 0,
      被误标记的摘要: summaryIdsInRemoveList.map((s) => ({ id: s.id, seq: s.metadata?.summarySeq })),
    });

    console.log(`[${this.logPrefix}] 🎯 执行ID列表净化`, {
      要移除的ID数量: idsToRemove.size,
      示例ID: Array.from(idsToRemove).slice(0, 3),
    });

    this.debug(
      '🎯 执行ID列表净化',
      {
        要移除的ID数量: idsToRemove.size,
        示例ID: Array.from(idsToRemove).slice(0, 3),
      },
      context,
    );

    const removedMessages: AiMessage[] = [];
    const finalMessages = messages.filter((msg) => {
      if (msg.id === latestSummary.id) {
        return true;
      }

      if (idsToRemove.has(msg.id)) {
        removedMessages.push(msg);
        return false;
      }

      const sourceIds = msg.metadata?.replacementSourceIds as string[] | undefined;
      if (sourceIds && Array.isArray(sourceIds)) {
        for (const sourceId of sourceIds) {
          if (idsToRemove.has(sourceId)) {
            removedMessages.push(msg);
            return false;
          }
        }
      }

      return true;
    });

    const removedCount = messages.length - finalMessages.length;
    const coveredRemovedIds = new Set<string>();
    for (const removedMessage of removedMessages) {
      if (typeof removedMessage.id === 'string' && idsToRemove.has(removedMessage.id)) {
        coveredRemovedIds.add(removedMessage.id);
      }
      const sourceIds = removedMessage.metadata?.replacementSourceIds;
      if (Array.isArray(sourceIds)) {
        for (const sourceId of sourceIds) {
          if (typeof sourceId === 'string' && idsToRemove.has(sourceId)) {
            coveredRemovedIds.add(sourceId);
          }
        }
      }
    }

    if (coveredRemovedIds.size !== idsToRemove.size) {
      const missingIds = Array.from(idsToRemove).filter((id) => !coveredRemovedIds.has(id));
      console.log(`[${this.logPrefix}] 🔍 移除差异详情`, {
        缺失ID数量: missingIds.length,
        缺失ID示例: missingIds.slice(0, 5),
      });
    }

    const summariesAfterClean = finalMessages.filter((m) => m.type === 'history_summary');
    console.log(`[${this.logPrefix}] 📤 净化后的消息列表:`, {
      净化后消息数: finalMessages.length,
      摘要消息数: summariesAfterClean.length,
      摘要ID列表: summariesAfterClean.map((s) => ({ id: s.id, seq: s.metadata?.summarySeq })),
      消息类型分布: finalMessages.reduce((acc, m) => {
        acc[m.type] = (acc[m.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });

    console.log(`[${this.logPrefix}] ✅ 净化完成: ${messages.length} → ${finalMessages.length} (移除了 ${removedCount} 条消息)`);
    console.log(
      `[${this.logPrefix}] 📊 要移除的ID数量: ${idsToRemove.size}, 实际移除消息: ${removedCount}, 覆盖source ids: ${coveredRemovedIds.size}`,
    );

    this.debug(
      '✅ 净化完成',
      {
        原始消息: messages.length,
        净化后消息: finalMessages.length,
        实际移除: removedCount,
        预期移除: idsToRemove.size,
        覆盖sourceIds: coveredRemovedIds.size,
      },
      context,
    );

    if (coveredRemovedIds.size !== idsToRemove.size) {
      console.log(`[${this.logPrefix}] ⚠️ 移除数量不匹配`, {
        预期: idsToRemove.size,
        实际覆盖: coveredRemovedIds.size,
        差异: idsToRemove.size - coveredRemovedIds.size,
      });

      this.debug(
        '⚠️ 移除数量不匹配',
        {
          预期: idsToRemove.size,
          实际覆盖: coveredRemovedIds.size,
          差异: idsToRemove.size - coveredRemovedIds.size,
        },
        context,
      );
    }

    return finalMessages;
  }
}
