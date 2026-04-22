import { generateMessageId } from '../../../../shared/ids';
import {
  BasePreprocessor,
  PreprocessorContext,
  PreprocessorResult,
} from './base';
import { createDefaultToolOutputSummarizer } from '../utils/toolOutputSummarizer';
import {
  buildToolInteractionGroupsFromMessages,
  findCurrentRoundStartIndex,
  type ToolInteractionGroup,
} from '../utils/toolInteractionGroup';
import type { AiMessage } from '../../../../contracts';

const CHECKPOINT_TOOL_NAME = 'context_checkpoint';

export class ToolHistoryCompressorPreprocessor extends BasePreprocessor {
  readonly name = 'ToolHistoryCompressorPreprocessor';
  readonly description = '工具历史压缩处理器 - 将较早的历史工具调用对压缩为自然语言记录消息';
  readonly priority = 0;

  private summarizer = createDefaultToolOutputSummarizer();
  private readonly keepLatestToolPairs: number;

  constructor(options?: { keepLatestToolPairs?: number }) {
    super();
    const keep = options?.keepLatestToolPairs ?? 2;
    this.keepLatestToolPairs = Math.max(0, Math.floor(keep));
  }

  async process(
    messages: AiMessage[],
    context: PreprocessorContext,
  ): Promise<PreprocessorResult> {
    this.debug('🔧 开始工具历史压缩处理', {
      原始消息数: messages.length,
    }, context);

    const currentRoundStartIndex = findCurrentRoundStartIndex(messages);
    const historyMessages = messages.slice(0, currentRoundStartIndex);
    const currentRoundMessages = messages.slice(currentRoundStartIndex);

    this.debug('📊 消息分段分析', {
      历史消息数: historyMessages.length,
      当前轮次消息数: currentRoundMessages.length,
      当前轮次起点索引: currentRoundStartIndex,
    }, context);

    const compressedHistory = this.compressToolCallPairsInHistory(historyMessages, context, {
      keepLatestPairs: this.keepLatestToolPairs,
    });

    const finalMessages = [...compressedHistory, ...currentRoundMessages];
    const originalCount = messages.length;
    const compressedCount = finalMessages.length;
    const removedCount = originalCount - compressedCount;
    const appliedStrategies = removedCount > 0 ? ['tool_history_compression'] : [];

    this.debug('✅ 工具历史压缩完成', {
      原始消息: originalCount,
      压缩后消息: compressedCount,
      减少消息: removedCount,
      Token节省估计: `约${removedCount * 50}个Token`,
    }, context);

    return this.createResult(
      messages,
      finalMessages,
      appliedStrategies,
      0,
    );
  }

  shouldSkip(messages: AiMessage[], context: PreprocessorContext): boolean {
    const hasToolCalls = messages.some((msg) =>
      (msg.role === 'assistant' && msg.type === 'tool_calls') ||
      (msg.role === 'tool' && msg.type === 'tool_output'),
    );

    if (!hasToolCalls) {
      this.debug('⏭️ 无工具调用消息，跳过历史压缩', {}, context);
      return true;
    }

    return false;
  }

  private compressToolCallPairsInHistory(
    historyMessages: AiMessage[],
    context: PreprocessorContext,
    options: { keepLatestPairs: number },
  ): AiMessage[] {
    if (historyMessages.length < 2) {
      return historyMessages;
    }

    const groups = buildToolInteractionGroupsFromMessages(historyMessages);
    if (groups.length === 0) {
      this.debug('🤔 在历史记录中未找到有效的工具交互组，跳过压缩', {}, context);
      return historyMessages;
    }

    const keepLatestPairs = Math.max(0, Math.floor(options.keepLatestPairs));
    const keepAnchorIds = new Set<string>();
    const completeGroups = groups.filter((group) => group.isComplete);
    const nonCheckpointGroups = completeGroups.filter((group) => !group.isCheckpointGroup);
    const checkpointGroups = completeGroups.filter((group) => group.isCheckpointGroup);

    if (keepLatestPairs > 0) {
      for (const group of nonCheckpointGroups.slice(-keepLatestPairs)) {
        keepAnchorIds.add(group.anchorId);
      }
    }
    if (checkpointGroups.length > 0) {
      keepAnchorIds.add(checkpointGroups[checkpointGroups.length - 1].anchorId);
    }

    const messagesToRemove = new Set<number>();
    const replacementMap = new Map<number, AiMessage>();

    for (const group of groups) {
      if (!group.isComplete || keepAnchorIds.has(group.anchorId)) {
        continue;
      }
      const compressedMessage = this.compressToolInteractionGroup(group, context);
      replacementMap.set(group.assistantIndex, compressedMessage);
      for (const messageIndex of group.messageIndexes) {
        messagesToRemove.add(messageIndex);
      }
    }

    if (messagesToRemove.size === 0) {
      return historyMessages;
    }

    const finalResult: AiMessage[] = [];
    for (let i = 0; i < historyMessages.length; i++) {
      if (messagesToRemove.has(i)) {
        if (replacementMap.has(i)) {
          const replacement = replacementMap.get(i);
          if (replacement) {
            finalResult.push(replacement);
          }
        }
      } else {
        finalResult.push(historyMessages[i]);
      }
    }

    return finalResult;
  }

  private compressToolInteractionGroup(
    group: ToolInteractionGroup<AiMessage>,
    context: PreprocessorContext,
  ): AiMessage {
    const summaryParts: string[] = [];
    for (const item of group.items) {
      const formattedArgs = this.summarizer.formatToolArgs(item.toolArgs);
      const argsPart = formattedArgs ? `（参数：${formattedArgs}）` : '';
      const outputSummaries = item.rawOutputs.map((rawOutput) =>
        this.summarizer.getSummary(item.toolName, rawOutput, context.toolSummaryProvider, item.toolArgs),
      );
      const mergedSummary = outputSummaries.join('；');
      summaryParts.push(`我已经调用了工具「${item.toolName}」${argsPart}，并得到了结果：${mergedSummary}`);
    }

    const compressedContent = `${summaryParts.join('；')}，我需要思考下一步行动`;

    return {
      id: generateMessageId(),
      role: 'assistant',
      type: 'final_answer',
      content: compressedContent,
      timestamp: group.assistantMessage.timestamp,
      metadata: {
        isCompressedToolHistory: true,
        replacementSourceIds: group.sourceMessageIds,
        compressedToolCallIds: group.toolCallIds,
        compressedToolNames: group.toolNames,
        toolInteractionGroupSize: group.items.length,
        containsCheckpoint: group.isCheckpointGroup,
      },
    };
  }
}
