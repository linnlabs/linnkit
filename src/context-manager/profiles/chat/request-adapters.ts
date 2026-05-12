import type { AgentProfileRequest } from '../agent/contracts';
import type { GenerateRequest } from './contracts';
import { aiMessageToChatMessage } from './utils/messageAdapters';
import type { AiMessage } from '../../../contracts';

export interface ChatGenerateRequestAdapterInput extends AgentProfileRequest {
  context_before?: string;
  context_after?: string;
  current_paragraph?: string;
  document_fragment?: string;
  document_title?: string;
  project_metadata?: {
    id?: string;
    name?: string;
    description?: string;
  };
  document_metadata?: {
    id?: string;
    title?: string;
  };
  user_quote?: {
    text: string;
    source?: Record<string, unknown>;
    display_label?: string;
  };
  completionLengthHint?: string;
  recentRejections?: GenerateRequest['recentRejections'];
}

/**
 * Product request adapter:
 * - keeps AgentInvokeRequest -> GenerateRequest conversion out of orchestrator core
 * - makes the remaining app-specific request shape explicit and replaceable
 */
export function buildGenerateRequestFromAgentRequest(
  request: ChatGenerateRequestAdapterInput,
  conversationHistory: AiMessage[],
): GenerateRequest {
  return {
    prompt: request.query,
    documentFragment: request.document_fragment,
    conversationHistory: conversationHistory.map((message) => aiMessageToChatMessage(message)),
    promptKey: request.promptKey,
    contextBefore: request.context_before,
    contextAfter: request.context_after,
    currentBlockContent: request.current_paragraph,
    current_paragraph: request.current_paragraph,
    projectMetadata: request.project_metadata
      ? {
          id: request.project_metadata.id,
          name: request.project_metadata.name,
          description: request.project_metadata.description,
        }
      : undefined,
    documentMetadata: request.document_metadata
      ? {
          id: request.document_metadata.id,
          title: request.document_metadata.title || request.document_title,
        }
      : (request.document_title ? { title: request.document_title } : undefined),
    userQuote: request.user_quote
      ? {
          text: request.user_quote.text,
          source: request.user_quote.source,
          displayLabel: request.user_quote.display_label,
        }
      : undefined,
    completionLengthHint: request.completionLengthHint,
    recentRejections: request.recentRejections,
  };
}
