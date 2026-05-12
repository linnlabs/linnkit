import {
  BasePreprocessor,
  type PreprocessorContext,
  type PreprocessorResult,
} from './base';
import type { AiMessage } from '../../../../contracts';

interface UserQuoteMetadata {
  text: string;
  source?: Record<string, unknown>;
}

export interface UserQuoteLifetimeConfig {
  keepLatestUserInputs?: number;
  priority?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUserQuoteMetadata(metadata: AiMessage['metadata']): UserQuoteMetadata | undefined {
  const quote = metadata?.user_quote;
  if (!isRecord(quote) || typeof quote.text !== 'string') {
    return undefined;
  }

  return {
    text: quote.text,
    source: isRecord(quote.source) ? quote.source : undefined,
  };
}

export class UserQuoteLifetimePreprocessor extends BasePreprocessor {
  readonly name = 'UserQuoteLifetimePreprocessor';
  readonly description = 'chat 兼容层：限制 <user_quote> 在历史中的生效轮数';
  readonly priority: number;

  private readonly keepLatestUserInputs: number;

  constructor(config: UserQuoteLifetimeConfig = {}) {
    super();
    this.keepLatestUserInputs = config.keepLatestUserInputs ?? 2;
    this.priority = config.priority ?? 3;
  }

  async process(messages: AiMessage[], context: PreprocessorContext): Promise<PreprocessorResult> {
    this.debug('🧹 开始处理 chat 用户引用寿命', {
      原始消息数: messages.length,
      保留用户输入条数: this.keepLatestUserInputs,
    }, context);

    if (messages.length === 0) {
      return this.createResult(messages, messages, [], 0);
    }

    const userInputIndices = messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.role === 'user' && msg.type === 'user_input')
      .map(({ index }) => index);

    if (userInputIndices.length === 0) {
      return this.createResult(messages, messages, [], 0);
    }

    const keepCount = Math.max(1, this.keepLatestUserInputs);
    const cutoff = Math.max(0, userInputIndices.length - keepCount);
    const indicesToStrip = userInputIndices.slice(0, cutoff);
    const keptIndices = userInputIndices.slice(cutoff);

    const processedMessages: AiMessage[] = [...messages];
    let modifiedCount = 0;

    for (const index of indicesToStrip) {
      const { message, modified } = this.stripUserQuoteFromMessage(processedMessages[index]);
      if (modified) {
        processedMessages[index] = message;
        modifiedCount++;
      }
    }

    for (const index of keptIndices) {
      const { message, modified } = this.ensureUserQuoteOnMessage(processedMessages[index]);
      if (modified) {
        processedMessages[index] = message;
        modifiedCount++;
      }
    }

    return this.createResult(
      messages,
      processedMessages,
      modifiedCount > 0 ? ['user_quote_lifetime'] : [],
      modifiedCount,
    );
  }

  private stripUserQuoteFromMessage(
    message: AiMessage,
  ): { message: AiMessage; modified: boolean } {
    let modified = false;
    let newContent = message.content;

    if (newContent.includes('<user_quote')) {
      const replaced = newContent.replace(/<user_quote[\s\S]*?<\/user_quote>\s*/gm, '').trimStart();
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
    const quote = readUserQuoteMetadata(message.metadata);
    if (!quote || message.content.includes('<user_quote')) {
      return { message, modified: false };
    }

    const quoteText = quote.text.trim();
    if (!quoteText) {
      return { message, modified: false };
    }

    const source = quote.source ?? {};
    const attrs: string[] = [];
    if (typeof source.doc_id === 'string') attrs.push(`source_doc="${source.doc_id}"`);
    if (typeof source.block_id === 'string') attrs.push(`block_id="${source.block_id}"`);
    if (typeof source.start === 'number') attrs.push(`start="${source.start}"`);
    if (typeof source.end === 'number') attrs.push(`end="${source.end}"`);

    const openTag = attrs.length > 0 ? `<user_quote ${attrs.join(' ')}>` : '<user_quote>';
    const quoteBlock = `${openTag}\n${quoteText}\n</user_quote>`;
    const queryBlock = `<user_query>\n${message.content.trim()}\n</user_query>`;

    return {
      message: {
        ...message,
        content: `${quoteBlock}\n${queryBlock}`,
      },
      modified: true,
    };
  }
}
