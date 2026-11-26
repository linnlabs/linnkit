import { z } from 'zod';
import {
  AgentSpecSystemReminderPolicy, AgentSpecToolObservationGovernancePolicy,
  ContextUsageSnapshot, RunIdSchema, RuntimeEvent, SerializableJsonRecord, ToolCallIdSchema,
} from '../../../contracts';
import { ENGINE_STATE_SCHEMA_VERSION, type EngineState } from '../types';

const counter = z.number().int().nonnegative();
const executor = z.object({
  stepCount: counter,
  phase: z.string().optional(), maxSteps: counter.optional(), remainingSteps: z.number().int().optional(),
  finalStepPolicy: z.enum(['final_answer', 'force_tools']).optional(),
  finalStepForcedTools: z.array(z.string()).optional(), lastStepsHintThreshold: counter.optional(),
  systemReminderPolicy: AgentSpecSystemReminderPolicy.optional(),
  toolObservationPolicy: AgentSpecToolObservationGovernancePolicy.optional(),
  // 已删除字段：0.45 及更早的 checkpoint 可能带 lastSuccessfulLlmModelId，0.46 及更早的可能带云端额度兜底留下的
  // runLockedModelId；照常接受，读入时丢弃（兜底已移除，恢复后按请求的模型继续）。
  runLockedModelId: z.string().optional(),
  lastSuccessfulLlmModelId: z.string().optional(),
  llmInvocationKind: z.enum(['user_initiated', 'continuation']).optional(),
  llmInvocationCount: counter.optional(), lockRequestedModelId: z.boolean().optional(),
  contextCompaction: z.object({
    attemptCount: counter, committedCount: counter, lastCommittedFingerprint: z.string().optional(),
  }).strict().optional(),
}).strict().transform(({ lastSuccessfulLlmModelId: _retired, runLockedModelId: _retiredLock, ...state }) => state);

const checkpoint = z.object({
  nodeId: z.string().min(1), schemaVersion: z.literal(ENGINE_STATE_SCHEMA_VERSION).optional(),
  revision: counter.optional(),
  executionStatus: z.enum(['ready', 'executing', 'yielded', 'awaiting_user']).optional(),
  local: z.object({
    runId: RunIdSchema.optional(), parentRunId: RunIdSchema.optional(),
    conversationId: z.string().optional(), turnId: z.string().optional(),
    request: SerializableJsonRecord.optional(),
    history: z.array(RuntimeEvent).optional(), newEvents: z.array(RuntimeEvent).optional(),
    executorLocal: executor.optional(),
    pendingToolCalls: z.array(z.object({
      id: ToolCallIdSchema, type: z.literal('function'),
      function: z.object({ name: z.string().min(1), arguments: z.string() }).strict(),
    }).strict()).optional(),
    executingToolCallIds: z.array(ToolCallIdSchema).optional(),
    // 0.47 及更早只记一个在途调用；照常接受，读入时转成只有一个成员的 executingToolCallIds。
    executingToolCallId: ToolCallIdSchema.optional(),
    toolBatchCompletionMode: z.enum(['continue_to_llm', 'yield_after_batch']).optional(),
    pendingInteractionSpec: SerializableJsonRecord.optional(), lastToolResult: SerializableJsonRecord.optional(),
    finalAnswer: z.string().optional(), answerId: z.string().optional(), chunkSeq: counter.optional(),
    contextUsage: ContextUsageSnapshot.optional(),
  }).passthrough().refine(
    local => local.executingToolCallId === undefined || local.executingToolCallIds === undefined,
    'Checkpoint must not carry both executingToolCallId and executingToolCallIds',
  ).transform(({ executingToolCallId: legacy, ...local }) => (
    legacy === undefined ? local : { ...local, executingToolCallIds: [legacy] }
  )).optional(),
}).strict();

/** 存储边界先验证数据形态，再验证 framework 字段；Host 不复制或断言 Graph 内部协议。 */
export function parseEngineCheckpoint(value: unknown): EngineState {
  const result = checkpoint.parse(SerializableJsonRecord.parse(value));
  for (const key of ['memory', 'signal', 'toolContext', 'runtimeEventSink', 'runtimeEventCommitPort',
    'runtimeFailureFactSink', 'summarizationCallbacks', 'commitExecutionBoundary', 'toolRecoveryPort',
    'pendingUserInputPort']) {
    if (result.local && Object.hasOwn(result.local, key)) {
      throw new Error(`Checkpoint must not contain execution capability: ${key}`);
    }
  }
  return result;
}
