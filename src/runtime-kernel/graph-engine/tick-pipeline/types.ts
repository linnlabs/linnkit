import type { AgentInvocationRequest, LlmRequestMessage, TokenizerPort } from '../../../ports';
import type {
  AnyAgentEvent,
  FinalAnswerEvent,
  ToolCallDecisionEvent,
} from '../../events/agentEvents';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';
import type { OpenAIToolSchema } from '../../tools/toolContracts';
import type { LlmCallOptions } from '../../llm/caller';
import type { TelemetryPort } from '../../telemetry/telemetryPort';
import type { AuditPort } from '../../../ports';
import type { ExecutorLocalState, StandardToolCall } from '../types';
import type { GraphExecutorSummarizationCallbacks } from '../executorContextBuilder';
import type { CanonicalLlmUsage, RuntimeEvent } from '../../../contracts';

export type TickEvent = AnyAgentEvent | RuntimeEvent;

export type AgentStepDecision =
  | { kind: 'tool_calls'; toolCalls: StandardToolCall[] }
  | { kind: 'final_answer'; answer: string }
  | { kind: 'wait_user'; pendingInteractionSpec: Record<string, unknown>; lastToolResult: Record<string, unknown> }
  | { kind: 'yield' }
  | { kind: 'error'; error: Error };

export interface TickInput {
  request: AgentInvocationRequest;
  toolContext?: ToolExecutionContext;
  stream?: boolean;
  history: RuntimeEvent[];
  signal?: AbortSignal;
  /**
   * 🔥 达到最大步数时的强制收尾开关：
   * - true 时：禁用工具（不下发 tools schema，tool_choice=none）
   * - 并注入 system 指令，要求模型必须直接输出最终答案
   */
  forceFinalAnswer?: boolean;
  /**
   * 执行阶段信号（由 GraphExecutor 注入到 local.executorLocal）
   *
   * 中文备注：
   * - SystemReminder 引擎会基于它生成 <system-reminder> 并追加到最后一条消息末尾
   * - 该字段仅用于“本次 tick 的 LLM 输入”，不得写入历史事件或持久化
   */
  executorLocal?: ExecutorLocalState;
  summarizationCallbacks?: GraphExecutorSummarizationCallbacks;
}

export interface TickOutput {
  decision: AgentStepDecision;
  newEvents: RuntimeEvent[];
}

export type LlmCallResponse =
  | string
  | {
      content: string;
      tool_calls?: StandardToolCall[];
      reasoning_details?: unknown[];
      usage?: unknown;
      canonicalUsage?: CanonicalLlmUsage;
    };

export interface TickPipelineContext {
  input: TickInput;
  eventHandler?: (event: TickEvent) => void;
  newEvents: RuntimeEvent[];
  request: AgentInvocationRequest;
  history: RuntimeEvent[];
  signal?: AbortSignal;
  forceFinalAnswer: boolean;
  executorLocal?: ExecutorLocalState;
  summarizationCallbacks?: GraphExecutorSummarizationCallbacks;
  modelId: string;
  toolSchemas: OpenAIToolSchema[];
  llmOptions: LlmCallOptions;
  llmMessages: LlmRequestMessage[];
  mode: 'agent' | 'chat';
  conversationId: string;
  turnId: string;
  llmCallStartedAt?: number;
  llmCallDurationMs?: number;
  llmResp?: LlmCallResponse;
  decision?: AgentStepDecision;
  systemReminderHitRuleIds?: string[];
  contextTrace?: unknown;
  cloudQuotaFallbackAppliedModelId?: string;
  modelFallbackAudit?: {
    fromModelId: string;
    toModelId: string;
    reason: string;
    policy: 'policy-switch' | 'cloud-quota';
  };
  /**
   * 由 GraphAgentExecutor 注入；middleware/stage 通过 ctx.telemetry.emit() 上报观测事件。
   * 默认 noopTelemetry，宿主侧可注入实际 sink（如 SQLite / OTEL / 自定义日志适配器）。
   */
  telemetry: TelemetryPort;
  audit: AuditPort;
  /**
   * LLM telemetry 本地估算也必须走 TokenizerPort，避免绕过 host 注入的 tokenizer。
   */
  tokenizer: TokenizerPort;
}

export type TickStageId =
  | 'prepare_call'
  | 'build_context'
  | 'apply_system_reminder'
  | 'execute_llm'
  | 'build_decision';

export interface TickStage {
  id: TickStageId;
  run(ctx: TickPipelineContext): Promise<void>;
}

export type TickStageRunner = () => Promise<void>;

export type TickAroundMiddleware = (
  ctx: TickPipelineContext,
  stage: TickStage,
  next: TickStageRunner,
) => Promise<void>;

export type TickDecisionEvent = FinalAnswerEvent | ToolCallDecisionEvent;
