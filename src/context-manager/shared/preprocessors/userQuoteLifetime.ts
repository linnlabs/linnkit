import {
  BasePreprocessor,
  type PreprocessorContext,
  type PreprocessorResult,
} from './base';
import type { AiMessage } from '../../../contracts';

export interface UserQuoteLifetimeConfig {
  keepLatestUserInputs?: number;
  priority?: number;
}

export class UserQuoteLifetimePreprocessor extends BasePreprocessor {
  readonly name = 'UserQuoteLifetimePreprocessor';
  readonly description = '限制 <user_quote> 在历史中的生效轮数（只保留最近若干条用户输入中的引用）';
  readonly priority: number;

  private readonly keepLatestUserInputs: number;

  constructor(config: UserQuoteLifetimeConfig = {}) {
    super();
    this.keepLatestUserInputs = config.keepLatestUserInputs ?? 2;
    this.priority = config.priority ?? 3;
  }

  async process(messages: AiMessage[], context: PreprocessorContext): Promise<PreprocessorResult> {
    this.debug('🧹 开始处理用户引用寿命', { 原始消息数: messages.length, 保留用户输入条数: this.keepLatestUserInputs }, context);

    if (messages.length === 0) {
      return this.createResult(messages, messages, [], 0);
    }

    const userInputIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user' && msg.type === 'user_input') {
        userInputIndices.push(i);
      }
    }

    this.debug('📚 用户输入时间线', {
      总消息数: messages.length,
      用户消息数: userInputIndices.length,
      用户消息示例: userInputIndices.slice(-3).map((idx) => ({
        index: idx,
        id: messages[idx]?.id,
        hasQuote: !!messages[idx]?.content?.includes('<user_quote>'),
        hasMetadataQuote: !!messages[idx]?.metadata?.user_quote,
      })),
    }, context);

    if (userInputIndices.length === 0) {
      this.debug('⏭️ 无 user_input 消息，跳过引用寿命处理', {}, context);
      return this.createResult(messages, messages, [], 0);
    }

    const keepCount = Math.max(1, this.keepLatestUserInputs);
    const cutoff = Math.max(0, userInputIndices.length - keepCount);
    const indicesToStrip = userInputIndices.slice(0, cutoff);
    const keptIndices = userInputIndices.slice(cutoff);

    const processedMessages: AiMessage[] = [...messages];
    let modifiedCount = 0;

    for (const idx of indicesToStrip) {
      const msg = processedMessages[idx];
      const { message: updatedMessage, modified } = this.stripUserQuoteFromMessage(msg);

      if (modified) {
        this.debug('✂️ 移除过期引用', {
          index: idx,
          id: msg.id,
          原始内容片段: typeof msg.content === 'string' ? msg.content.slice(0, 80) : undefined,
          处理后内容片段: typeof updatedMessage.content === 'string' ? updatedMessage.content.slice(0, 80) : undefined,
          metadata曾带引用: !!msg.metadata?.user_quote,
        }, context);
        processedMessages[idx] = updatedMessage;
        modifiedCount++;
      }
    }

    for (const idx of keptIndices) {
      const msg = processedMessages[idx];
      const { message: updatedMessage, modified } = this.ensureUserQuoteOnMessage(msg);

      if (modified) {
        this.debug('📌 保留引用到近期用户消息', {
          index: idx,
          id: msg.id,
          metadataQuote: !!msg.metadata?.user_quote,
        }, context);
        processedMessages[idx] = updatedMessage;
        modifiedCount++;
      } else {
        const hasMetadata = !!msg.metadata?.user_quote;
        const hasContentQuote = typeof msg.content === 'string' && msg.content.includes('<user_quote');

        if (!hasContentQuote && !hasMetadata) {
          this.debug('⚠️ 无法恢复引用：缺少元数据', {
            index: idx,
            id: msg.id,
            content: typeof msg.content === 'string' ? msg.content.slice(0, 50) : '',
            metadataKeys: msg.metadata ? Object.keys(msg.metadata) : [],
          }, context);
        }
      }
    }

    this.debug('✅ 用户引用寿命处理完成', {
      原始消息: messages.length,
      修改消息数: modifiedCount,
      保留范围: keepCount,
    }, context);

    const appliedStrategies = modifiedCount > 0 ? ['user_quote_lifetime'] : [];
    return this.createResult(messages, processedMessages, appliedStrategies, modifiedCount);
  }

  private stripUserQuoteFromMessage(
    message: AiMessage,
  ): { message: AiMessage; modified: boolean } {
    let modified = false;
    let newContent = message.content;

    if (typeof newContent === 'string' && newContent.includes('<user_quote')) {
      const userQuoteBlockRegex = /<user_quote[\s\S]*?<\/user_quote>\s*/gm;
      const replaced = newContent.replace(userQuoteBlockRegex, '').trimStart();
      if (replaced !== newContent) {
        newContent = replaced;
        modified = true;
      }
    }

    let newMetadata = message.metadata;
    if (message.metadata?.user_quote) {
      newMetadata = { ...message.metadata };
      delete newMetadata.user_quote;
      modified = true;
    }

    if (!modified) {
      return { message, modified: false };
    }

    return {
      message: {
        ...message,
        content: newContent,
        ...(newMetadata ? { metadata: newMetadata } : {}),
      },
      modified: true,
    };
  }

  private ensureUserQuoteOnMessage(
    message: AiMessage,
  ): { message: AiMessage; modified: boolean } {
    const quote = message.metadata && (message.metadata as any).user_quote;
    if (!quote) {
      return { message, modified: false };
    }

    if (typeof quote.text !== 'string') {
      this.debug('⚠️ 引用元数据格式错误: text不是字符串', {
        id: message.id,
        quoteType: typeof quote,
        textType: typeof quote?.text,
        quoteKeys: Object.keys(quote || {}),
        quoteValue: JSON.stringify(quote),
      });
      return { message, modified: false };
    }

    if (typeof message.content !== 'string') {
      this.debug('⚠️ 消息内容不是字符串', { id: message.id, contentType: typeof message.content });
      return { message, modified: false };
    }

    if (message.content.includes('<user_quote')) {
      this.debug('ℹ️ 消息已包含引用标签，跳过恢复', { id: message.id });
      return { message, modified: false };
    }

    const quoteText = quote.text.trim();
    if (!quoteText) {
      this.debug('⚠️ 引用文本为空', { id: message.id });
      return { message, modified: false };
    }

    const source = (quote.source || {}) as Record<string, unknown>;
    const attrs: string[] = [];

    if (typeof source.doc_id === 'string') {
      attrs.push(`source_doc="${source.doc_id}"`);
    }
    if (typeof source.block_id === 'string') {
      attrs.push(`block_id="${source.block_id}"`);
    }
    if (typeof source.start === 'number') {
      attrs.push(`start="${source.start}"`);
    }
    if (typeof source.end === 'number') {
      attrs.push(`end="${source.end}"`);
    }

    const openTag = attrs.length > 0 ? `<user_quote ${attrs.join(' ')}>` : '<user_quote>';
    const queryText = message.content.trim();
    const quoteBlock = `${openTag}\n${quoteText}\n</user_quote>`;
    const queryBlock = `<user_query>\n${queryText}\n</user_query>`;

    return {
      message: {
        ...message,
        content: `${quoteBlock}\n${queryBlock}`,
      },
      modified: true,
    };
  }
}
