import { z } from 'zod';

import { SerializableJsonRecord, SerializableJsonValue } from './json';
import { Status, ToolCallPhase } from './runtime-status';
import { FinalAnswerCompletionReason } from './final-answer';
import {
  AnswerSegmentIdSchema,
  SourceEventIdSchema,
  SubrunIdSchema,
  ToolCallIdSchema,
} from './identity';

/**
 * Child trace 事件类别的唯一 Runtime 合同。
 *
 * Host 查询、持久化读取、SSE 与插件公开类型都必须从这里派生；禁止在消费层
 * 重列 enum 或用 switch 维护另一份“可读取 kind”清单。
 */
export const SubRunTraceKind = z.enum([
  'thought_delta',
  'thought_complete',
  'tool_call_decision',
  'tool_process',
  'tool_output',
  'final_answer_chunk',
  'final_answer',
]);
export type SubRunTraceKind = z.infer<typeof SubRunTraceKind>;

export const SubRunTracePayload = z.object({
  parent_tool_call_id: ToolCallIdSchema,
  subrun_id: SubrunIdSchema,
  subrun_parent_id: SubrunIdSchema.optional(),
  source_event_id: SourceEventIdSchema,
  kind: SubRunTraceKind,
  delta: z.string().optional(),
  content: z.string().optional(),
  answer_id: AnswerSegmentIdSchema.optional(),
  seq: z.number().int().nonnegative().optional(),
  is_last: z.boolean().optional(),
  completion_reason: FinalAnswerCompletionReason.optional(),
  tool_name: z.string().optional(),
  tool_call_id: ToolCallIdSchema.optional(),
  phase: ToolCallPhase.optional(),
  status: Status.optional(),
  args: SerializableJsonValue.optional(),
  output: SerializableJsonValue.optional(),
  duration_ms: z.number().optional(),
  meta: SerializableJsonRecord.optional(),
});

export type SubRunTracePayload = z.infer<typeof SubRunTracePayload>;

/**
 * trace 的归并字段必须由共享协议校验，不能留给 Host 或 Renderer 各自猜测。
 * 这里单独保留语义校验，是因为 RuntimeEvent 与 SSEEvent 共享 payload，基础 envelope 不同。
 */
export function validateSubRunTracePayloadSemantics(
  payload: SubRunTracePayload,
  ctx: z.RefinementCtx,
): void {
  if (payload.kind === 'thought_delta' && payload.delta === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['delta'], message: 'thought_delta requires delta' });
  }
  if (payload.kind === 'thought_complete' && payload.content === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'thought_complete requires content' });
  }
  if (payload.kind === 'final_answer_chunk') {
    if (payload.answer_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answer_id'], message: 'final_answer_chunk requires answer_id' });
    }
    if (payload.seq === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['seq'], message: 'final_answer_chunk requires seq' });
    }
    if (payload.delta === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['delta'], message: 'final_answer_chunk requires delta' });
    }
  }
  if (payload.kind === 'final_answer') {
    if (payload.answer_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answer_id'], message: 'final_answer requires answer_id' });
    }
    if (payload.content === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'final_answer requires content' });
    }
    if (payload.completion_reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['completion_reason'],
        message: 'final_answer requires completion_reason',
      });
    }
  }
  if (
    payload.kind === 'tool_call_decision'
    || payload.kind === 'tool_process'
    || payload.kind === 'tool_output'
  ) {
    if (payload.tool_name === undefined || payload.tool_name.trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tool_name'], message: `${payload.kind} requires tool_name` });
    }
    if (payload.tool_call_id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tool_call_id'], message: `${payload.kind} requires tool_call_id` });
    }
  }
  if (payload.kind === 'tool_call_decision' || payload.kind === 'tool_process') {
    if (payload.phase === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phase'], message: `${payload.kind} requires phase` });
    }
    if (payload.status === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: `${payload.kind} requires status` });
    }
  }
  if (
    payload.kind === 'tool_output'
    && payload.status !== 'success'
    && payload.status !== 'error'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'tool_output requires success or error status',
    });
  }
}
