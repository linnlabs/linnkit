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
  runLockedModelId: z.string().optional(), lastSuccessfulLlmModelId: z.string().optional(),
  llmInvocationKind: z.enum(['user_initiated', 'continuation']).optional(),
  llmInvocationCount: counter.optional(), lockRequestedModelId: z.boolean().optional(),
  contextCompaction: z.object({
    attemptCount: counter, committedCount: counter, lastCommittedFingerprint: z.string().optional(),
  }).strict().optional(),
}).strict();

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
    executingToolCallId: ToolCallIdSchema.optional(),
    toolBatchCompletionMode: z.enum(['continue_to_llm', 'yield_after_batch']).optional(),
    pendingInteractionSpec: SerializableJsonRecord.optional(), lastToolResult: SerializableJsonRecord.optional(),
    finalAnswer: z.string().optional(), answerId: z.string().optional(), chunkSeq: counter.optional(),
    contextUsage: ContextUsageSnapshot.optional(),
  }).passthrough().optional(),
}).strict();

/** 存储边界先验证数据形态，再验证 framework 字段；Host 不复制或断言 Graph 内部协议。 */
export function parseEngineCheckpoint(value: unknown): EngineState {
  const result = checkpoint.parse(SerializableJsonRecord.parse(value));
  for (const key of ['memory', 'signal', 'toolContext', 'runtimeEventSink', 'runtimeEventCommitPort',
    'runtimeFailureFactSink', 'summarizationCallbacks', 'commitExecutionBoundary', 'toolRecoveryPort']) {
    if (result.local && Object.hasOwn(result.local, key)) {
      throw new Error(`Checkpoint must not contain execution capability: ${key}`);
    }
  }
  return result;
}
