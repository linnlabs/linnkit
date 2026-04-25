import { z } from 'zod';

export const BaseEvent = z.object({
  id: z.string(),
  conversation_id: z.string(),
  timestamp: z.number(),
  metadata: z.record(z.unknown()).optional(),
  version: z.literal(1).default(1),
  turn_id: z.string(),
  ephemeral: z.boolean().optional(),
});

export const ToolCallPhase = z.enum(['start', 'update', 'complete', 'error']);
export const Status = z.enum(['loading', 'success', 'error']);
export const AgentTodoStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

export const AgentTodoItem = z.object({
  id: z.string(),
  content: z.string(),
  status: AgentTodoStatus,
});

export const ProviderReasoningDetailsPayload = z.array(z.unknown());
export type ProviderReasoningDetailsPayload = z.infer<typeof ProviderReasoningDetailsPayload>;

export const ToolCallDecisionPayload = z.object({
  args: z.record(z.any()).optional(),
  tool_calls: z.array(z.unknown()).optional(),
  /**
   * 不透明 provider reasoning replay blocks。
   *
   * RuntimeEvent 层的标准位置是 tool_call_decision.payload.reasoning_details；
   * context-manager 会把它回放到 AiMessage.metadata.reasoning_details。
   */
  reasoning_details: ProviderReasoningDetailsPayload.optional(),
}).passthrough();

export type ToolCallDecisionPayload = z.infer<typeof ToolCallDecisionPayload>;

export const RuntimeEvent = z.discriminatedUnion('type', [
  BaseEvent.extend({
    type: z.literal('user_input'),
    content: z.string(),
    raw_content: z.string().optional(),
    source: z.enum(['user', 'editor', 'system']).default('user'),
  }),
  BaseEvent.extend({
    type: z.literal('thought'),
    content: z.string(),
    thought_message_id: z.string().optional(),
    delta: z.string().optional(),
    is_complete: z.boolean().default(false),
  }),
  BaseEvent.extend({
    type: z.literal('tool_call_decision'),
    tool_name: z.string(),
    tool_call_id: z.string(),
    phase: ToolCallPhase,
    status: Status,
    args: z.record(z.any()).optional(),
    payload: ToolCallDecisionPayload.optional(),
    parent_tool_call_id: z.string().optional(),
    meta: z.record(z.any()).optional(),
  }),
  BaseEvent.extend({
    type: z.literal('tool_process'),
    tool_name: z.string(),
    tool_call_id: z.string(),
    phase: ToolCallPhase,
    status: Status,
    args: z.record(z.any()).optional(),
    payload: z.record(z.any()).optional(),
    parent_tool_call_id: z.string().optional(),
    meta: z.record(z.any()).optional(),
  }),
  BaseEvent.extend({
    type: z.literal('tool_output'),
    tool_name: z.string(),
    tool_call_id: z.string(),
    status: z.enum(['success', 'error']),
    output: z.any().optional(),
    payload: z.record(z.any()).optional(),
    error: z.string().optional(),
    duration_ms: z.number().optional(),
  }),
  BaseEvent.extend({
    type: z.literal('todo_updated'),
    todo_list_id: z.string(),
    todo_list_version: z.number().int().nonnegative(),
    items: z.array(AgentTodoItem),
  }),
  BaseEvent.extend({
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
    phase: ToolCallPhase.optional(),
    status: Status.optional(),
    args: z.unknown().optional(),
    output: z.unknown().optional(),
    duration_ms: z.number().optional(),
    meta: z.record(z.unknown()).optional(),
  }),
  BaseEvent.extend({
    type: z.literal('requires_user_interaction'),
    form: z.any().optional(),
    interaction_type: z.string().optional(),
    prompt: z.string().optional(),
  }),
  BaseEvent.extend({
    type: z.literal('final_answer'),
    answer_id: z.string(),
    content: z.string(),
    is_complete: z.boolean().default(true),
    meta: z.record(z.any()).optional(),
  }),
  BaseEvent.extend({
    type: z.literal('final_answer_chunk'),
    answer_id: z.string(),
    seq: z.number().int().nonnegative(),
    content: z.string(),
    is_last: z.boolean().optional(),
  }),
  BaseEvent.extend({
    type: z.literal('history_summary'),
    content: z.string(),
    replaced_message_ids: z.array(z.string()),
    summary_seq: z.number().int().nonnegative(),
    original_message_count: z.number().int().nonnegative().optional(),
    compression_ratio: z.number().min(0).max(1).optional(),
    included_old_summary: z.boolean().optional(),
  }),
  BaseEvent.extend({
    type: z.literal('error'),
    error: z.string(),
    details: z.any().optional(),
    error_code: z.string().optional(),
    retryable: z.boolean().optional(),
  }),
  BaseEvent.extend({
    type: z.literal('control'),
    op: z.enum(['truncate_after', 'replace', 'redo', 'branch']),
    target_id: z.string().optional(),
    reason: z.string().optional(),
    meta: z.any().optional(),
  }),
  BaseEvent.extend({
    type: z.literal('stream_end'),
    reason: z.enum(['complete', 'error', 'interrupted', 'timeout']).optional(),
    stats: z.object({
      total_events: z.number().optional(),
      duration_ms: z.number().optional(),
      error_count: z.number().optional(),
    }).optional(),
  }),
]);

export type RuntimeEvent = z.infer<typeof RuntimeEvent>;
export type UserInputEvent = Extract<RuntimeEvent, { type: 'user_input' }>;
export type ThoughtEvent = Extract<RuntimeEvent, { type: 'thought' }>;
export type ToolCallDecisionEvent = Extract<RuntimeEvent, { type: 'tool_call_decision' }>;
export type ToolProcessEvent = Extract<RuntimeEvent, { type: 'tool_process' }>;
export type ToolOutputEvent = Extract<RuntimeEvent, { type: 'tool_output' }>;
export type TodoUpdatedEvent = Extract<RuntimeEvent, { type: 'todo_updated' }>;
export type SubRunTraceEvent = Extract<RuntimeEvent, { type: 'subrun_trace' }>;
export type RequiresUserInteractionEvent = Extract<RuntimeEvent, { type: 'requires_user_interaction' }>;
export type FinalAnswerEvent = Extract<RuntimeEvent, { type: 'final_answer' }>;
export type FinalAnswerChunkEvent = Extract<RuntimeEvent, { type: 'final_answer_chunk' }>;
export type HistorySummaryEvent = Extract<RuntimeEvent, { type: 'history_summary' }>;
export type ErrorEvent = Extract<RuntimeEvent, { type: 'error' }>;
export type ControlEvent = Extract<RuntimeEvent, { type: 'control' }>;
export type StreamEndEvent = Extract<RuntimeEvent, { type: 'stream_end' }>;

export const validateRuntimeEvent = (event: unknown) => RuntimeEvent.safeParse(event);
export const validateRuntimeEvents = (events: unknown[]) => z.array(RuntimeEvent).safeParse(events);

export const createUserInputEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  content: string,
  options: Partial<UserInputEvent> = {},
): UserInputEvent => ({
  type: 'user_input',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  content,
  source: 'user',
  ...options,
});

export const createThoughtEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  content: string,
  options: Partial<ThoughtEvent> = {},
): ThoughtEvent => ({
  type: 'thought',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  content,
  is_complete: false,
  ...options,
});

export const createToolCallDecisionEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  toolName: string,
  toolCallId: string,
  options: Partial<ToolCallDecisionEvent> = {},
): ToolCallDecisionEvent => ({
  type: 'tool_call_decision',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  tool_name: toolName,
  tool_call_id: toolCallId,
  phase: 'start',
  status: 'loading',
  ...options,
});

export const createToolProcessEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  toolName: string,
  toolCallId: string,
  options: Partial<ToolProcessEvent> = {},
): ToolProcessEvent => ({
  type: 'tool_process',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  tool_name: toolName,
  tool_call_id: toolCallId,
  phase: 'start',
  status: 'loading',
  ...options,
});

export const createSubRunTraceEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  parentToolCallId: string,
  subrunId: string,
  kind: SubRunTraceEvent['kind'],
  options: Partial<SubRunTraceEvent> = {},
): SubRunTraceEvent => ({
  type: 'subrun_trace',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  ephemeral: true,
  parent_tool_call_id: parentToolCallId,
  subrun_id: subrunId,
  kind,
  ...options,
});

export const createToolOutputEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  toolName: string,
  toolCallId: string,
  output: unknown,
  status: 'success' | 'error' = 'success',
  options: Partial<ToolOutputEvent> = {},
): ToolOutputEvent => ({
  type: 'tool_output',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  tool_name: toolName,
  tool_call_id: toolCallId,
  status,
  output,
  ...options,
});

export const createTodoUpdatedEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  todoListId: string,
  todoListVersion: number,
  items: TodoUpdatedEvent['items'],
  options: Partial<TodoUpdatedEvent> = {},
): TodoUpdatedEvent => ({
  type: 'todo_updated',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  todo_list_id: todoListId,
  todo_list_version: todoListVersion,
  items,
  ...options,
});

export const createFinalAnswerEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  answerId: string,
  content: string,
  options: Partial<FinalAnswerEvent> = {},
): FinalAnswerEvent => ({
  type: 'final_answer',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  answer_id: answerId,
  content,
  is_complete: true,
  ...options,
});

export const createFinalAnswerChunkEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  answerId: string,
  seq: number,
  content: string,
  options: Partial<FinalAnswerChunkEvent> = {},
): FinalAnswerChunkEvent => ({
  type: 'final_answer_chunk',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  answer_id: answerId,
  seq,
  content,
  ...options,
});

export const createHistorySummaryEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  content: string,
  replacedMessageIds: string[],
  summarySeq: number,
  options: Partial<HistorySummaryEvent> = {},
): HistorySummaryEvent => ({
  type: 'history_summary',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  content,
  replaced_message_ids: replacedMessageIds,
  summary_seq: summarySeq,
  ...options,
});

export const createErrorEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  error: string,
  options: Partial<ErrorEvent> = {},
): ErrorEvent => ({
  type: 'error',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  error,
  ...options,
});

export const createStreamEndEvent = (
  id: string,
  conversationId: string,
  turnId: string,
  options: Partial<StreamEndEvent> = {},
): StreamEndEvent => ({
  type: 'stream_end',
  id,
  conversation_id: conversationId,
  turn_id: turnId,
  timestamp: Date.now(),
  version: 1,
  ...options,
});
