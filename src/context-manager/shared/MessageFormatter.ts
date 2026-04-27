import type { ChatMessage } from '../profiles/chat/contracts';
import type { AiMessage } from '../../contracts';
import type { FenceRegistry } from './fences';

export interface MessageFormatOptions {
  nativeTools?: boolean;
  mode?: 'agent' | 'chat';
  fenceRegistry?: FenceRegistry;
}

export interface MessageFormatterOptions {
  fenceRegistry?: FenceRegistry;
}

export type NativeToolCallingMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning_details?: unknown[]; provider_empty_replay_field?: true }
  | { role: 'assistant'; content: string | null; tool_calls: unknown[]; reasoning_details?: unknown[]; provider_empty_replay_field?: true }
  | { role: 'tool'; tool_call_id: string; content: string };

class MessageFormatter {
  private readonly fenceRegistry?: FenceRegistry;

  constructor(options: MessageFormatterOptions = {}) {
    this.fenceRegistry = options.fenceRegistry;
  }

  public format(
    messages: AiMessage[],
    options: { nativeTools: true; mode?: 'agent' | 'chat' },
  ): NativeToolCallingMessage[];
  public format(
    messages: AiMessage[],
    options?: { nativeTools?: false; mode?: 'agent' | 'chat' },
  ): ChatMessage[];
  public format(messages: AiMessage[], options: MessageFormatOptions = {}): (ChatMessage | NativeToolCallingMessage)[] {
    const processedMessages = options.mode === 'agent' ? messages : this.mergeThoughtAndAnswer(messages);
    return processedMessages
      .map((msg) => this.formatSingleMessage(msg, options))
      .filter((msg): msg is ChatMessage | NativeToolCallingMessage => msg !== null);
  }

  private mergeThoughtAndAnswer(messages: AiMessage[]): AiMessage[] {
    const processedMessages: AiMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const currentMsg = messages[i];
      const nextMsg = messages[i + 1];
      if (this.shouldMergeWithNext(currentMsg, nextMsg)) {
        processedMessages.push(this.performMerge(currentMsg, nextMsg));
        i++;
        continue;
      }
      processedMessages.push(currentMsg);
    }
    return processedMessages;
  }

  private shouldMergeWithNext(current: AiMessage, next: AiMessage | undefined): boolean {
    if (!next) {
      return false;
    }
    return current.role === 'assistant' && next.role === 'assistant' && current.type === 'thought' && next.type === 'final_answer';
  }

  private performMerge(thought: AiMessage, answer: AiMessage): AiMessage {
    return {
      id: answer.id,
      role: 'assistant',
      type: 'final_answer',
      content: `<think>${thought.content}</think>${answer.content}`,
      timestamp: answer.timestamp,
      metadata: {
        ...answer.metadata,
        ...thought.metadata,
        isMergedMessage: true,
        originalIds: [thought.id, answer.id],
      },
    };
  }

  private formatSingleMessage(
    message: AiMessage,
    options: MessageFormatOptions,
  ): ChatMessage | NativeToolCallingMessage | null {
    const { role, type, content, metadata } = message;
    const fenceRegistry = options.fenceRegistry ?? this.fenceRegistry;

    if (options.nativeTools) {
      if (role === 'assistant' && type === 'tool_calls' && metadata?.tool_calls) {
        const toolCallsRaw = metadata.tool_calls;
        const toolCalls = Array.isArray(toolCallsRaw) ? toolCallsRaw : [];
        const reasoningDetailsRaw = metadata.reasoning_details;
        const reasoningDetails = Array.isArray(reasoningDetailsRaw) ? reasoningDetailsRaw : undefined;
        const shouldUseProviderEmptyReplayField = metadata.provider_empty_replay_field === true;
        return {
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls,
          ...(reasoningDetails && reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
          ...(shouldUseProviderEmptyReplayField ? { provider_empty_replay_field: true as const } : {}),
        };
      }

      if (role === 'assistant' && type === 'final_answer') {
        const reasoningDetailsRaw = metadata?.reasoning_details;
        const reasoningDetails = Array.isArray(reasoningDetailsRaw) ? reasoningDetailsRaw : undefined;
        const shouldUseProviderEmptyReplayField = metadata?.provider_empty_replay_field === true;
        return {
          role: 'assistant',
          content,
          ...(reasoningDetails && reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
          ...(shouldUseProviderEmptyReplayField ? { provider_empty_replay_field: true as const } : {}),
        };
      }

      if (role === 'tool' && type === 'tool_output' && metadata?.tool_call_id) {
        return {
          role: 'tool',
          tool_call_id: metadata.tool_call_id,
          content,
        };
      }
    }

    if (type === 'tool_output') {
      return null;
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      return null;
    }

    switch (type) {
      case 'system_prompt':
      case 'user_input':
      case 'final_answer':
        return { role, content };
      case 'context_injection': {
        const fenceKind = metadata?.fenceKind;
        if (!fenceKind) {
          console.warn('[MessageFormatter] context_injection missing metadata.fenceKind, skipping.');
          return null;
        }
        const descriptor = fenceRegistry?.get(fenceKind);
        if (!descriptor) {
          console.warn(`[MessageFormatter] Fence kind "${fenceKind}" is not registered, skipping.`);
          return null;
        }
        return {
          role: descriptor.llmRole,
          content: descriptor.formatter(content, metadata?.fenceAttrs ?? {}),
        };
      }
      case 'document_fragment': {
        const trimmedContent = (content || '').trim();
        const wrapped = trimmedContent ? `<additional_context>\n${trimmedContent}\n</additional_context>` : '<additional_context />';
        return { role: 'system', content: wrapped };
      }
      case 'history_summary':
        return { role: 'system', content };
      case 'thought':
        return { role, content: content.includes('<think>') ? content : `<think>${content}</think>` };
      case 'tool_calls': {
        const toolCalls = metadata?.tool_calls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          const firstToolCall = toolCalls[0];
          const toolName = firstToolCall.function?.name;
          const toolArgs = firstToolCall.function?.arguments;
          if (toolName && toolArgs) {
            const call = {
              name: toolName,
              arguments: typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs,
            };
            return { role, content: `<tool_code>${JSON.stringify(call)}</tool_code>` };
          }
        }
        return null;
      }
      case 'tool_code': {
        const { tool_name, args } = metadata || {};
        if (tool_name && args) {
          return { role, content: `<tool_code>${JSON.stringify({ name: tool_name, arguments: args })}</tool_code>` };
        }
        return null;
      }
      case 'task_request':
        return { role, content };
      case 'task_completion':
        return { role, content: `[任务完成] ${content}` };
      default:
        console.warn(`[MessageFormatter] Unhandled message type for chat history: "${type}", skipping.`);
        return null;
    }
  }

}

export const messageFormatter = new MessageFormatter();
export function createMessageFormatter(options: MessageFormatterOptions = {}): MessageFormatter {
  return new MessageFormatter(options);
}
export function formatAgentLlmMessages(
  messages: AiMessage[],
  options: Pick<MessageFormatOptions, 'fenceRegistry'> = {},
): NativeToolCallingMessage[] {
  return messageFormatter.format(messages, { nativeTools: true, mode: 'agent', ...options });
}
export type LlmMessage = ChatMessage | NativeToolCallingMessage;
