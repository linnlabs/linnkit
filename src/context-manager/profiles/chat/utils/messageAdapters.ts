import type { ChatMessage } from '../contracts';
import { generateMessageId } from '../../../../shared/ids';
import type { AiMessage, UserMessage } from '../../../../contracts';

export function aiMessageToChatMessage(aiMessage: AiMessage): ChatMessage {
  return {
    id: aiMessage.id,
    timestamp: aiMessage.timestamp,
    role: aiMessage.role,
    content: aiMessage.content,
    type: aiMessage.type,
    metadata: aiMessage.metadata,
  };
}

export function chatMessageToAiMessage(
  chatMessage: ChatMessage,
  options: { id?: string; timestamp?: number } = {},
): AiMessage {
  const { role, content, type, metadata, id: chatId } = chatMessage;
  const id = options.id || chatId || generateMessageId();

  const base = {
    id,
    content,
    timestamp: chatMessage.timestamp || options.timestamp || Date.now(),
    metadata,
  };

  switch (role) {
    case 'system': {
      const allowedSystemTypes = ['system_prompt', 'history_summary'] as const;
      const finalSystemType = (allowedSystemTypes as readonly string[]).includes(String(type))
        ? (type as typeof allowedSystemTypes[number])
        : 'system_prompt';
      return { ...base, role, type: finalSystemType };
    }
    case 'user': {
      const userType = type || 'user_input';
      if (
        ['user_input', 'context_before', 'context_after', 'document_fragment', 'image', 'task_request'].includes(
          userType,
        )
      ) {
        return { ...base, role, type: userType as UserMessage['type'] };
      }
      throw new Error(`Invalid type "${userType}" for role "user"`);
    }
    case 'assistant': {
      if (type === 'thought' || type === 'final_answer' || type === 'task_completion') {
        return { ...base, role, type };
      }
      throw new Error(`Invalid or missing type "${type}" for role "assistant"`);
    }
    default:
      throw new Error(`Unknown role: ${role}`);
  }
}
