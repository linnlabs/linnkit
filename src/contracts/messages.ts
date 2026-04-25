import { z } from 'zod';

export const ProviderReasoningDetails = z.array(z.unknown());
export type ProviderReasoningDetails = z.infer<typeof ProviderReasoningDetails>;

export const ToolCallExtraContent = z.object({
  google: z.object({
    thought_signature: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export type ToolCallExtraContent = z.infer<typeof ToolCallExtraContent>;

export const ToolCallWire = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
  extra_content: ToolCallExtraContent.optional(),
}).passthrough();

export type ToolCallWire = z.infer<typeof ToolCallWire>;

export const HistorySummaryMeta = z.object({
  messageType: z.literal('summary'),
  originalMessageCount: z.number().int().positive(),
  compressionRatio: z.number().min(0).max(1).optional(),
  includedOldSummary: z.boolean(),
  replacedMessageIds: z.array(z.string()),
  summarySeq: z.number().int().nonnegative(),
});

export type HistorySummaryMeta = z.infer<typeof HistorySummaryMeta>;

export const ToolCallsMeta = z.object({
  tool_calls: z.array(ToolCallWire),
  reasoning_details: ProviderReasoningDetails.optional(),
});

export type ToolCallsMeta = z.infer<typeof ToolCallsMeta>;

export const ToolOutputMeta = z.object({
  tool_name: z.string(),
  args: z.record(z.unknown()).optional(),
  tool_call_id: z.string(),
});

export type ToolOutputMeta = z.infer<typeof ToolOutputMeta>;

export const ImageInfoMeta = z.object({
  url: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  format: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export type ImageInfoMeta = z.infer<typeof ImageInfoMeta>;

export const TaskTrackingMeta = z.object({
  taskType: z.string().optional(),
  taskId: z.string().optional(),
  taskStatus: z.enum(['requested', 'in_progress', 'completed', 'failed']).optional(),
  taskTrackingInfo: z.object({
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    duration: z.number().optional(),
    retryCount: z.number().int().nonnegative().optional(),
    lastError: z.string().optional(),
  }).optional(),
});

export type TaskTrackingMeta = z.infer<typeof TaskTrackingMeta>;

export const PersistentMetadata = z.object({
  messageType: z.literal('summary').optional(),
  originalMessageCount: z.number().int().positive().optional(),
  compressionRatio: z.number().min(0).max(1).optional(),
  includedOldSummary: z.boolean().optional(),
  replacedMessageIds: z.array(z.string()).optional(),
  summarySeq: z.number().int().nonnegative().optional(),
  tool_calls: z.array(ToolCallWire).optional(),
  reasoning_details: ProviderReasoningDetails.optional(),
  tool_name: z.string().optional(),
  args: z.record(z.unknown()).optional(),
  tool_call_id: z.string().optional(),
  raw_output: z.string().optional(),
  image_info: ImageInfoMeta.optional(),
  taskType: z.string().optional(),
  taskId: z.string().optional(),
  taskStatus: z.enum(['requested', 'in_progress', 'completed', 'failed']).optional(),
  taskTrackingInfo: z.object({
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    duration: z.number().optional(),
    retryCount: z.number().int().nonnegative().optional(),
    lastError: z.string().optional(),
  }).optional(),
}).passthrough();

export type PersistentMetadata = z.infer<typeof PersistentMetadata>;

const BaseMessage = z.object({
  id: z.string(),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
  metadata: PersistentMetadata.optional(),
});

export const SystemMessage = BaseMessage.extend({
  role: z.literal('system'),
  type: z.enum(['system_prompt', 'history_summary']),
});

export type SystemMessage = z.infer<typeof SystemMessage>;

export const UserMessage = BaseMessage.extend({
  role: z.literal('user'),
  type: z.enum([
    'user_input',
    'context_before',
    'context_after',
    'document_fragment',
    'task_request',
    'image',
  ]),
});

export type UserMessage = z.infer<typeof UserMessage>;

export const AssistantMessage = BaseMessage.extend({
  role: z.literal('assistant'),
  type: z.enum([
    'thought',
    'final_answer',
    'tool_code',
    'tool_calls',
    'task_completion',
  ]),
});

export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const ToolMessage = BaseMessage.extend({
  role: z.literal('tool'),
  type: z.literal('tool_output'),
});

export type ToolMessage = z.infer<typeof ToolMessage>;

export const AiMessage = z.discriminatedUnion('role', [
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
]);

export type AiMessage = z.infer<typeof AiMessage>;

export function createSystemMessage(
  type: SystemMessage['type'],
  content: string,
  metadata?: PersistentMetadata,
): SystemMessage {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    type,
    content,
    timestamp: Date.now(),
    metadata,
  };
}

export function createUserMessage(
  type: UserMessage['type'],
  content: string,
  metadata?: PersistentMetadata,
): UserMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    type,
    content,
    timestamp: Date.now(),
    metadata,
  };
}

export function createAssistantMessage(
  type: AssistantMessage['type'],
  content: string,
  metadata?: PersistentMetadata,
): AssistantMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    type,
    content,
    timestamp: Date.now(),
    metadata,
  };
}

export function createToolMessage(
  content: string,
  toolCallId: string,
  toolName: string,
  metadata?: PersistentMetadata,
): ToolMessage {
  return {
    id: crypto.randomUUID(),
    role: 'tool',
    type: 'tool_output',
    content,
    timestamp: Date.now(),
    metadata: {
      ...metadata,
      tool_call_id: toolCallId,
      tool_name: toolName,
    },
  };
}

export function createHistorySummaryMessage(
  content: string,
  summaryMeta: HistorySummaryMeta,
): SystemMessage {
  return {
    id: crypto.randomUUID(),
    role: 'system',
    type: 'history_summary',
    content,
    timestamp: Date.now(),
    metadata: summaryMeta,
  };
}

export function validateAiMessage(data: unknown): z.SafeParseReturnType<unknown, AiMessage> {
  return AiMessage.safeParse(data);
}

export function validateHistorySummaryMeta(
  data: unknown,
): z.SafeParseReturnType<unknown, HistorySummaryMeta> {
  return HistorySummaryMeta.safeParse(data);
}

export function isSystemMessage(message: AiMessage): message is SystemMessage {
  return message.role === 'system';
}

export function isUserMessage(message: AiMessage): message is UserMessage {
  return message.role === 'user';
}

export function isAssistantMessage(message: AiMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

export function isToolMessage(message: AiMessage): message is ToolMessage {
  return message.role === 'tool';
}

export function isHistorySummaryMessage(message: AiMessage): message is SystemMessage {
  return message.role === 'system'
    && message.type === 'history_summary'
    && message.metadata?.messageType === 'summary';
}

export function hasToolCalls(message: AiMessage): boolean {
  return message.role === 'assistant'
    && Array.isArray(message.metadata?.tool_calls)
    && message.metadata.tool_calls.length > 0;
}
