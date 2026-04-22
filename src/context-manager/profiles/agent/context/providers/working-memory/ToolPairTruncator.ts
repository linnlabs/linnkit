import type { AgentContextBuilderConfig } from '../../config';
import type { TruncationResult, DebugFn } from './types';
import {
  createDefaultToolOutputSummarizer,
  type SummarizerConfig,
} from '../../../utils/toolOutputSummarizer';
import type { ToolInteractionGroup } from '../../../utils/toolInteractionGroup';
import type { MessageProcessingState } from '../base';
import type { AiMessage } from '../../../../../../contracts';

/**
 * 工具对截断器
 *
 * 负责超大工具对的智能截断，通过摘要技术压缩 tool_output
 */
export class ToolPairTruncator {
  constructor(private readonly config: AgentContextBuilderConfig) {}

  /**
   * 智能截断超大的工具对
   *
   * 🔥 核心功能：当工具对因尺寸过大无法装入上下文时，
   * 通过智能摘要技术对 tool_output 进行压缩，
   * 确保 Agent 不会丢失关键的工具执行信息
   */
  truncate(
    group: ToolInteractionGroup<MessageProcessingState>,
    estimateTokens: (message: AiMessage) => number,
    debugFn?: DebugFn
  ): TruncationResult {
    if (group.toolOutputs.length === 0) {
      debugFn?.('❌ 截断失败：工具组内没有可截断的 tool_output', {
        anchorId: group.anchorId,
      });
      return { success: false, tokensSaved: 0 };
    }
    const summarizer = createDefaultToolOutputSummarizer(this.createToolOutputSummaryConfig());
    let tokensSaved = 0;

    for (const item of group.items) {
      for (let index = 0; index < item.toolOutputs.length; index += 1) {
        const toolOutputState = item.toolOutputs[index];
        const toolOutputMessage = toolOutputState.message;
        const originalOutput = item.rawOutputs[index] ?? toolOutputMessage.content;
        const originalTokens = toolOutputState.tokens;
        const summary = summarizer.getSummary(
          item.toolName,
          originalOutput,
          undefined,
          item.toolArgs,
        );

        toolOutputMessage.content = summary;
        toolOutputMessage.metadata = {
          ...toolOutputMessage.metadata,
          truncated: true,
          originalLength: originalOutput.length,
          truncatedLength: summary.length,
        };
        toolOutputState.tokens = estimateTokens(toolOutputMessage);
        tokensSaved += originalTokens - toolOutputState.tokens;
      }
    }

    debugFn?.('✅ 工具组截断成功', {
      锚点消息: group.anchorId,
      工具数量: group.items.length,
      toolOutput数量: group.toolOutputs.length,
      节省Token: tokensSaved,
    });

    return { success: tokensSaved > 0, tokensSaved };
  }

  /**
   * 基于 Agent 配置生成工具输出摘要器配置
   * - 目标：让截断后的 tool_output 摘要长度接近 MAX_TOOL_OUTPUT_SUMMARY_TOKENS
   * - 原则：依然保持"首尾预览"结构，提升信息量，但避免无上限膨胀
   */
  private createToolOutputSummaryConfig(): Partial<SummarizerConfig> {
    const maxSummaryChars = Math.floor(this.config.MAX_TOOL_OUTPUT_SUMMARY_TOKENS * this.config.AVG_CHARS_PER_TOKEN);
    // 文本摘要格式包含固定前缀/引号/省略号等，预留一定空间，避免超出目标
    const wrapperReserveChars = 160;
    const previewChars = Math.max(200, Math.floor((maxSummaryChars - wrapperReserveChars) / 2));

    return {
      textPreviewLength: previewChars,
    };
  }
}
