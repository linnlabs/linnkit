import { z } from 'zod';

export const BaseSSEEvent = z.object({
  id: z.string(),
  timestamp: z.number(),
  conversation_id: z.string(),
  turn_id: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export type BaseSSEEvent = z.infer<typeof BaseSSEEvent>;

export const SSEThoughtEvent = BaseSSEEvent.extend({
  type: z.literal('thought'),
  thought_message_id: z.string().optional(),
  delta: z.string().optional(),
  content: z.string().optional(),
  is_complete: z.boolean().default(false),
});

export type SSEThoughtEvent = z.infer<typeof SSEThoughtEvent>;

export const SSEFinalAnswerChunkEvent = BaseSSEEvent.extend({
  type: z.literal('final_answer_chunk'),
  answer_id: z.string(),
  seq: z.number().int().nonnegative(),
  chunk: z.string(),
  is_last: z.boolean().optional(),
});

export type SSEFinalAnswerChunkEvent = z.infer<typeof SSEFinalAnswerChunkEvent>;

export const SSEFinalAnswerEvent = BaseSSEEvent.extend({
  type: z.literal('final_answer'),
  answer_id: z.string(),
  content: z.string(),
  meta: z.record(z.any()).optional(),
});

export type SSEFinalAnswerEvent = z.infer<typeof SSEFinalAnswerEvent>;

export const SSEMarkdownChunkEvent = BaseSSEEvent.extend({
  type: z.literal('markdown_chunk'),
  content_type: z.enum(['text', 'code', 'table', 'image']).default('text'),
  text: z.string(),
  seq: z.number().optional(),
});

export type SSEMarkdownChunkEvent = z.infer<typeof SSEMarkdownChunkEvent>;

const BaseSSEToolLifecycleEvent = BaseSSEEvent.extend({
  tool_name: z.string(),
  tool_call_id: z.string(),
  phase: z.enum(['start', 'update', 'complete', 'error']),
  status: z.enum(['loading', 'success', 'error']),
  args: z.any().optional(),
  payload: z.any().optional(),
  meta: z.record(z.any()).optional(),
});

export const SSEToolCallDecisionEvent = BaseSSEToolLifecycleEvent.extend({
  type: z.literal('tool_call_decision'),
});

export type SSEToolCallDecisionEvent = z.infer<typeof SSEToolCallDecisionEvent>;

export const SSEToolProcessEvent = BaseSSEToolLifecycleEvent.extend({
  type: z.literal('tool_process'),
});

export type SSEToolProcessEvent = z.infer<typeof SSEToolProcessEvent>;

export const SSEToolOutputEvent = BaseSSEEvent.extend({
  type: z.literal('tool_output'),
  tool_name: z.string(),
  tool_call_id: z.string(),
  status: z.enum(['success', 'error']),
  output: z.any().optional(),
  payload: z.record(z.any()).optional(),
  duration_ms: z.number().optional(),
});

export type SSEToolOutputEvent = z.infer<typeof SSEToolOutputEvent>;

export const SSETodoUpdatedEvent = BaseSSEEvent.extend({
  type: z.literal('todo_updated'),
  todo_list_id: z.string(),
  todo_list_version: z.number().int().nonnegative(),
  items: z.array(z.object({
    id: z.string(),
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
  })),
});

export type SSETodoUpdatedEvent = z.infer<typeof SSETodoUpdatedEvent>;

export const SSESubRunTraceEvent = BaseSSEEvent.extend({
  type: z.literal('subrun_trace'),
  parent_tool_call_id: z.string(),
  subrun_id: z.string(),
  subrun_parent_id: z.string().optional(),
  kind: z.enum([
    'thought_delta',
    'thought_complete',
    'tool_call_decision',
    'tool_process',
    'tool_output',
    'final_answer_chunk',
    'final_answer',
  ]),
  delta: z.string().optional(),
  content: z.string().optional(),
  tool_name: z.string().optional(),
  tool_call_id: z.string().optional(),
  phase: z.enum(['start', 'update', 'complete', 'error']).optional(),
  status: z.enum(['loading', 'success', 'error']).optional(),
  args: z.unknown().optional(),
  output: z.unknown().optional(),
  duration_ms: z.number().optional(),
  meta: z.record(z.unknown()).optional(),
});

export type SSESubRunTraceEvent = z.infer<typeof SSESubRunTraceEvent>;

export const SSERequiresUserInteractionEvent = BaseSSEEvent.extend({
  type: z.literal('requires_user_interaction'),
  form: z.any().optional(),
  interaction_type: z.string().optional(),
  prompt: z.string().optional(),
});

export type SSERequiresUserInteractionEvent = z.infer<typeof SSERequiresUserInteractionEvent>;

export const SSEErrorEvent = BaseSSEEvent.extend({
  type: z.literal('error'),
  error: z.string(),
  details: z.any().optional(),
  error_code: z.string().optional(),
  retryable: z.boolean().optional(),
});

export type SSEErrorEvent = z.infer<typeof SSEErrorEvent>;

export const SSEStreamEndEvent = BaseSSEEvent.extend({
  type: z.literal('stream_end'),
  reason: z.enum(['complete', 'error', 'interrupted', 'timeout']).optional(),
  reason_message: z.string().optional(),
  stats: z.object({
    total_events: z.number().optional(),
    duration_ms: z.number().optional(),
    error_count: z.number().optional(),
    benchmark: z.record(z.unknown()).optional(),
  }).optional(),
});

export type SSEStreamEndEvent = z.infer<typeof SSEStreamEndEvent>;

export const SSEHistorySummaryEvent = BaseSSEEvent.extend({
  type: z.literal('history_summary'),
  summary_id: z.string(),
  content: z.string(),
  original_message_count: z.number().int().nonnegative(),
  summary_seq: z.number().int().nonnegative(),
});

export type SSEHistorySummaryEvent = z.infer<typeof SSEHistorySummaryEvent>;

export const SSESummarizationStartEvent = BaseSSEEvent.extend({
  type: z.literal('summarization_start'),
  originalMessages: z.number().optional(),
});

export type SSESummarizationStartEvent = z.infer<typeof SSESummarizationStartEvent>;

export const SSESummarizationEndEvent = BaseSSEEvent.extend({
  type: z.literal('summarization_end'),
  originalMessages: z.number().optional(),
  compressedMessages: z.number().optional(),
  compressionRatio: z.string().optional(),
  timeSaved: z.string().optional(),
});

export type SSESummarizationEndEvent = z.infer<typeof SSESummarizationEndEvent>;

export const SSESummarizationErrorEvent = BaseSSEEvent.extend({
  type: z.literal('summarization_error'),
  error: z.string(),
});

export type SSESummarizationErrorEvent = z.infer<typeof SSESummarizationErrorEvent>;

export const SSEEvent = z.discriminatedUnion('type', [
  SSEThoughtEvent,
  SSEFinalAnswerChunkEvent,
  SSEFinalAnswerEvent,
  SSEMarkdownChunkEvent,
  SSEToolCallDecisionEvent,
  SSEToolProcessEvent,
  SSEToolOutputEvent,
  SSETodoUpdatedEvent,
  SSESubRunTraceEvent,
  SSERequiresUserInteractionEvent,
  SSEErrorEvent,
  SSEStreamEndEvent,
  SSEHistorySummaryEvent,
  SSESummarizationStartEvent,
  SSESummarizationEndEvent,
  SSESummarizationErrorEvent,
]);

export type SSEEvent = z.infer<typeof SSEEvent>;

export const validateSSEEvent = (event: unknown) => SSEEvent.safeParse(event);

export const createSSEThoughtEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  options: { thought_message_id?: string; delta?: string; content?: string; is_complete?: boolean } = {},
): SSEThoughtEvent => ({
  type: 'thought',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  is_complete: false,
  ...options,
});

export const createSSEFinalAnswerChunkEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  answerId: string,
  seq: number,
  chunk: string,
  options: { is_last?: boolean } = {},
): SSEFinalAnswerChunkEvent => ({
  type: 'final_answer_chunk',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  answer_id: answerId,
  seq,
  chunk,
  ...options,
});

export const createSSEFinalAnswerEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  answerId: string,
  content: string,
  options: Partial<SSEFinalAnswerEvent> = {},
): SSEFinalAnswerEvent => ({
  type: 'final_answer',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  answer_id: answerId,
  content,
  ...options,
});

export const createSSEMarkdownChunkEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  text: string,
  options: Partial<SSEMarkdownChunkEvent> = {},
): SSEMarkdownChunkEvent => ({
  type: 'markdown_chunk',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  text,
  content_type: 'text',
  ...options,
});

export const createSSEToolCallDecisionEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  toolName: string,
  toolCallId: string,
  phase: SSEToolCallDecisionEvent['phase'],
  status: SSEToolCallDecisionEvent['status'],
  options: Partial<SSEToolCallDecisionEvent> = {},
): SSEToolCallDecisionEvent => ({
  type: 'tool_call_decision',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  tool_name: toolName,
  tool_call_id: toolCallId,
  phase,
  status,
  ...options,
});

export const createSSEToolProcessEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  toolName: string,
  toolCallId: string,
  phase: SSEToolProcessEvent['phase'],
  status: SSEToolProcessEvent['status'],
  options: Partial<SSEToolProcessEvent> = {},
): SSEToolProcessEvent => ({
  type: 'tool_process',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  tool_name: toolName,
  tool_call_id: toolCallId,
  phase,
  status,
  ...options,
});

export const createSSEToolOutputEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  toolName: string,
  toolCallId: string,
  status: SSEToolOutputEvent['status'],
  output: unknown,
  options: Partial<SSEToolOutputEvent> = {},
): SSEToolOutputEvent => ({
  type: 'tool_output',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  tool_name: toolName,
  tool_call_id: toolCallId,
  status,
  output,
  ...options,
});

export const createSSETodoUpdatedEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  todoListId: string,
  todoListVersion: number,
  items: SSETodoUpdatedEvent['items'],
  options: Partial<SSETodoUpdatedEvent> = {},
): SSETodoUpdatedEvent => ({
  type: 'todo_updated',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  todo_list_id: todoListId,
  todo_list_version: todoListVersion,
  items,
  ...options,
});

export const createSSESubRunTraceEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  parentToolCallId: string,
  subrunId: string,
  kind: SSESubRunTraceEvent['kind'],
  options: Partial<SSESubRunTraceEvent> = {},
): SSESubRunTraceEvent => ({
  type: 'subrun_trace',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  parent_tool_call_id: parentToolCallId,
  subrun_id: subrunId,
  kind,
  ...options,
});

export const createSSERequiresUserInteractionEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  options: Partial<SSERequiresUserInteractionEvent> = {},
): SSERequiresUserInteractionEvent => ({
  type: 'requires_user_interaction',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  ...options,
});

export const createSSEErrorEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  error: string,
  options: Partial<SSEErrorEvent> = {},
): SSEErrorEvent => ({
  type: 'error',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  error,
  ...options,
});

export const createSSEStreamEndEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  options: Partial<SSEStreamEndEvent> = {},
): SSEStreamEndEvent => ({
  type: 'stream_end',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  ...options,
});

export const createSSEHistorySummaryEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  summaryId: string,
  content: string,
  originalMessageCount: number,
  summarySeq: number,
  options: Partial<SSEHistorySummaryEvent> = {},
): SSEHistorySummaryEvent => ({
  type: 'history_summary',
  id,
  timestamp: Date.now(),
  conversation_id: conversationId,
  turn_id: turnId,
  summary_id: summaryId,
  content,
  original_message_count: originalMessageCount,
  summary_seq: summarySeq,
  ...options,
});
