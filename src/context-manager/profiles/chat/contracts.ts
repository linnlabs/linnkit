import type { AiMessage } from '../../../contracts';

export type MessageType = AiMessage['type'];
export type MessageRole = AiMessage['role'];

export interface ChatMessage {
  id?: string;
  timestamp?: number;
  role: MessageRole;
  content: string;
  type?: MessageType;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatProjectMetadata {
  id?: string;
  name?: string;
  description?: string;
}

export interface ChatDocumentMetadata {
  id?: string;
  title?: string;
}

export interface ChatUserQuote {
  text: string;
  source?: Record<string, unknown>;
  displayLabel?: string;
}

export interface RecentRejection {
  suggestionText: string;
  userContinuedWith?: string;
}

export interface GenerateRequest {
  prompt: string;
  promptKey: string;
  conversationHistory?: ChatMessage[];
  contextBefore?: string;
  contextAfter?: string;
  currentBlockContent?: string;
  current_paragraph?: string;
  documentFragment?: string;
  modelId?: string;
  conversationId?: string;
  projectMetadata?: ChatProjectMetadata;
  documentMetadata?: ChatDocumentMetadata;
  userQuote?: ChatUserQuote;
  completionLengthHint?: string;
  recentRejections?: RecentRejection[];
  intentKey?:
    | 'continue_paragraph'
    | 'list_next_item'
    | 'bridge_to_suffix_delimiter'
    | 'rewrite_after_large_delete'
    | 'structure_editing';
  intentConfidence?: number;
  intentConstraints?: string[];
  behaviorSummary?: {
    totalEvents: number;
    totalInsertedChars: number;
    totalDeletedChars: number;
    recentDeletedChars?: number;
    hasLargeRecentDelete?: boolean;
    typingSpeedCps?: number;
  };
}

export interface GenerateResponse {
  generatedText: string;
}
