export interface ConversationArtifactContext {
  conversationId?: string;
  conversation_id?: string;
  sharedMemory?: {
    instanceId?: string;
  } | Record<string, unknown>;
  research?: {
    instanceId?: string;
  } | Record<string, unknown>;
  [key: string]: unknown;
}
