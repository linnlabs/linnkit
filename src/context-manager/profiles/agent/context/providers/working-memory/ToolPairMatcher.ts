import type { AgentContextBuilderConfig } from '../../config';
import type { MessageProcessingState } from '../base';
import type { ToolPairFitResult, DebugFn } from './types';
import {
  buildToolInteractionGroupsFromStates,
  type ToolInteractionGroup,
} from '../../../utils/toolInteractionGroup';
import type { AiMessage } from '../../../../../../contracts';

/**
 * 工具对配对器
 *
 * 负责工具调用与工具结果的配对匹配，确保工具交互的完整性
 */
export class ToolPairMatcher {
  constructor(private readonly config: AgentContextBuilderConfig) {}

  /**
   * 判断是否为"预处理阶段压缩的工具历史摘要消息"
   * - 该类消息不再是 tool_calls/tool_output 的原始结构，而是 assistant 的自然语言记录
   * - 但它本质上仍代表一个工具交互组，应该在 P3（历史工具交互）阶段被优先/受限地纳入上下文
   */
  isCompressedToolHistoryMessage(message: AiMessage): boolean {
    const meta = message.metadata;
    return (
      message.role === 'assistant' &&
      message.type === 'final_answer' &&
      typeof meta?.['isCompressedToolHistory'] === 'boolean' &&
      meta['isCompressedToolHistory'] === true
    );
  }

  /**
   * 查找工具调用的配对消息
   * 从 assistant 消息向后查找对应的 tool 消息
   */
  findToolCallPair(
    assistantState: MessageProcessingState,
    allStates: MessageProcessingState[]
  ): ToolInteractionGroup<MessageProcessingState> | null {
    return this.findGroupByAnchorId(assistantState.message.id, allStates);
  }

  /**
   * 查找工具结果的配对消息
   * 从 tool 消息向前反向查找对应的 assistant 消息
   */
  findToolResultPair(
    toolState: MessageProcessingState,
    allStates: MessageProcessingState[]
  ): ToolInteractionGroup<MessageProcessingState> | null {
    const toolCallId = toolState.message.metadata?.tool_call_id;
    if (!toolCallId) {
      return null;
    }
    const groups = buildToolInteractionGroupsFromStates(allStates);
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      if (group.toolCallIds.includes(toolCallId) && group.toolOutputs.some((state) => state.message.id === toolState.message.id)) {
        return group;
      }
    }
    return null;
  }

  /**
   * 检查工具配对是否能在预算内保留
   */
  canFitToolPair(
    group: ToolInteractionGroup<MessageProcessingState>,
    currentTokens: number,
    budgetLimit: number,
    debugFn?: DebugFn
  ): ToolPairFitResult {
    const pair = group.messages;
    const pairTokens = pair.reduce((sum, state) => sum + state.tokens, 0);

    // 检查预算限制
    if (currentTokens + pairTokens > budgetLimit) {
      return {
        canFit: false,
        needsTruncation: true,
        group,
        pair: pair,
        totalTokens: pairTokens,
        reason: 'budget_exceeded'
      };
    }

    // 检查单个工具交互对的最大Token限制
    if (pairTokens > this.config.MAX_TOOL_PAIR_TOKENS) {
      debugFn?.('⚠️ 工具交互对超过最大Token限制', {
        pairTokens,
        maxAllowed: this.config.MAX_TOOL_PAIR_TOKENS
      });
      return {
        canFit: false,
        needsTruncation: true,
        group,
        pair: pair,
        totalTokens: pairTokens,
        reason: 'pair_too_large'
      };
    }

    return {
      canFit: true,
      needsTruncation: false,
      group,
      pair: pair,
      totalTokens: pairTokens
    };
  }

  private findGroupByAnchorId(
    anchorId: string,
    allStates: MessageProcessingState[],
  ): ToolInteractionGroup<MessageProcessingState> | null {
    if (!anchorId) {
      return null;
    }
    const groups = buildToolInteractionGroupsFromStates(allStates);
    return groups.find((group) => group.anchorId === anchorId) ?? null;
  }
}
