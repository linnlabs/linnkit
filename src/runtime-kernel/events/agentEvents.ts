/**
 * @file runtime-kernel/events/agentEvents.ts
 * @description graph 主执行链使用的最小 Agent 事件契约
 *
 * 中文备注：
 * - 该文件只承载 runtime-kernel 主链路真正需要识别的事件子集；
 * - 目标是让 `executor` / `llmNode` / `eventMappers` 不再反向依赖宿主或产品层事件定义；
 * - host/product 层若有更丰富的事件，只要结构兼容，仍可在边界透传进来。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export interface AgentEvent {
  type: string;
  timestamp: number;
  id?: string;
  /**
   * 中文备注：
   * - 该标记只在运行期内存中使用，用于避免同一事件被 SSE 重复分发；
   * - 不属于持久化协议字段。
   */
  __dispatched_via_sse__?: true;
}

interface BaseToolLifecycleAgentEvent extends AgentEvent {
  tool_name: string;
  tool_args: Record<string, unknown>;
  tool_calls?: unknown[];
  tool_call_id?: string;
  phase?: 'start' | 'update' | 'complete' | 'error';
  status?: 'loading' | 'success' | 'error';
  payload?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface ThoughtEvent extends AgentEvent {
  type: 'thought';
  content: string;
  delta?: string;
  is_complete?: boolean;
  meta?: Record<string, unknown>;
  thought_message_id?: string;
}

export interface ToolCallDecisionEvent extends BaseToolLifecycleAgentEvent {
  type: 'tool_call_decision';
}

export interface ToolProcessEvent extends BaseToolLifecycleAgentEvent {
  type: 'tool_process';
}

export interface ObservationEvent extends AgentEvent {
  type: 'observation';
  tool_name: string;
  tool_call_id?: string;
  output: string;
  success?: boolean;
  payload?: Record<string, unknown>;
  duration_ms?: number;
}

export interface FinalAnswerEvent extends AgentEvent {
  type: 'final_answer';
  answer: string;
  answer_id?: string;
  answerId?: string;
  meta?: Record<string, unknown>;
}

export interface ErrorEvent extends AgentEvent {
  type: 'error';
  error: string;
  details?: string;
}

export interface StreamChunkEvent extends AgentEvent {
  type: 'stream_chunk';
  content: string;
  answer_id?: string;
  seq?: number;
  is_last?: boolean;
  isLast?: boolean;
}

export type AnyAgentEvent =
  | ThoughtEvent
  | ToolCallDecisionEvent
  | ToolProcessEvent
  | ObservationEvent
  | FinalAnswerEvent
  | ErrorEvent
  | StreamChunkEvent;

export function isMarkedAsSseDispatched(event: unknown): boolean {
  return isRecord(event) && event['__dispatched_via_sse__'] === true;
}

export function readAgentEventAnswerId(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;

  const snake = event['answer_id'];
  if (typeof snake === 'string' && snake.trim().length > 0) {
    return snake.trim();
  }

  const camel = event['answerId'];
  if (typeof camel === 'string' && camel.trim().length > 0) {
    return camel.trim();
  }

  return undefined;
}

export function readAgentEventSeq(event: unknown): number | undefined {
  if (!isRecord(event)) return undefined;
  const value = event['seq'];
  return Number.isInteger(value) ? Number(value) : undefined;
}
