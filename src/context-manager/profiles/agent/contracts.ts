/**
 * @file src/agent/context-manager/profiles/agent/contracts.ts
 */

import type { AiMessage } from '../../../contracts';

export interface AgentProfileProjectMetadata {
  id?: string;
  name?: string;
  description?: string;
}

export interface AgentProfileDocumentMetadata {
  id?: string;
  title?: string;
}

export interface AgentProfileUserQuote {
  text: string;
  source?: Record<string, unknown>;
  display_label?: string;
}

export interface AgentProfileRecentRejection {
  suggestionText: string;
  userContinuedWith?: string;
}

/**
 * Minimal request contract used by package-neutral agent profile code.
 * Product-specific invoke requests can extend this shape.
 */
export interface AgentProfileRequest {
  query: string;
  promptKey: string;
  context_before?: string;
  context_after?: string;
  document_fragment?: string;
  document_title?: string;
  current_paragraph?: string;
  injected_context?: string;
  availableTools?: string[];
  conversationHistory?: AiMessage[];
  project_metadata?: AgentProfileProjectMetadata;
  document_metadata?: AgentProfileDocumentMetadata;
  user_quote?: AgentProfileUserQuote;
  completionLengthHint?: string;
  recentRejections?: AgentProfileRecentRejection[];
}
