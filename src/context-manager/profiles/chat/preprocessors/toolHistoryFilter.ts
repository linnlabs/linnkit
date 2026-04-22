import {
  BasePreprocessor,
  PreprocessorContext,
  PreprocessorResult
} from './base';
import type { AiMessage } from '../../../../contracts';

/**
 * 工具历史过滤器预处理器
 *
 * 过滤掉Agent模式产生的、与Chat模式不兼容的工具调用历史消息。
 */
export class ToolHistoryFilterPreprocessor extends BasePreprocessor {
  readonly name = 'ToolHistoryFilterPreprocessor';
  readonly description = '移除Agent历史记录中与Chat模式不兼容的工具调用消息';
  readonly priority = 2; // 在历史净化之后执行

  /**
   * 功能: 执行工具历史过滤处理。
   * @param messages {AiMessage[]} 输入的消息列表。
   * @param context {PreprocessorContext} 预处理上下文。
   * @returns {Promise<PreprocessorResult>} 过滤后的结果。
   * @side-effects 无
   */
  async process(
    messages: AiMessage[],
    context: PreprocessorContext
  ): Promise<PreprocessorResult> {
    this.debug('🧹 开始过滤工具调用历史', {
      原始消息数: messages.length
    }, context);

    const filteredMessages = messages.filter(msg => {
      const isToolCall = msg.role === 'assistant' && msg.type === 'tool_calls';
      const isToolOutput = msg.role === 'tool' && msg.type === 'tool_output';
      return !isToolCall && !isToolOutput;
    });

    const removedCount = messages.length - filteredMessages.length;
    const appliedStrategies = removedCount > 0 ? ['tool_history_filtering'] : [];

    this.debug('✅ 工具历史过滤完成', {
      原始消息: messages.length,
      过滤后消息: filteredMessages.length,
      移除消息: removedCount
    }, context);

    return this.createResult(
      messages,
      filteredMessages,
      appliedStrategies,
      0
    );
  }

  /**
   * 功能: 判断是否应跳过此预处理器。
   * @param messages {AiMessage[]} 输入的消息列表。
   * @param context {PreprocessorContext} 预处理上下文。
   * @returns {boolean} 如果没有工具相关的消息，则返回 true 跳过。
   * @side-effects 无
   */
  shouldSkip(messages: AiMessage[], context: PreprocessorContext): boolean {
    const hasToolMessages = messages.some(msg =>
      (msg.role === 'assistant' && msg.type === 'tool_calls') ||
      (msg.role === 'tool' && msg.type === 'tool_output')
    );

    if (!hasToolMessages) {
      this.debug('⏭️ 无工具调用历史，跳过过滤', {}, context);
      return true;
    }

    return false;
  }
}
