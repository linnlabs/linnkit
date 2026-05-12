import { z } from 'zod';

const JsonRecord = z.record(z.string(), z.unknown());

export const AUDIT_ACTIONS = [
  'model.select',
  'model.fallback',
  'tool.allow',
  'tool.deny',
  'wait_user.request',
  'sandbox.decide',
  'run.cancel',
  'run.pause',
  'run.resume',
  'memory.write',
] as const;

export const AUDIT_DECISION_OUTCOMES = [
  'allowed',
  'denied',
  'fallback',
  'retry',
  'cancelled',
  'paused',
  'resumed',
  'requested',
  'recorded',
] as const;

export const AuditActor = z.object({
  kind: z.enum(['system', 'host', 'agent', 'model', 'tool', 'user']),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
export type AuditActor = z.infer<typeof AuditActor>;

export const AuditDecision = z.object({
  outcome: z.enum(AUDIT_DECISION_OUTCOMES),
  reason: z.string().optional(),
  policy: z.string().optional(),
  metadata: JsonRecord.optional(),
});
export type AuditDecision = z.infer<typeof AuditDecision>;

export const AuditEvidence = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1).optional(),
  summary: z.string().optional(),
  metadata: JsonRecord.optional(),
});
export type AuditEvidence = z.infer<typeof AuditEvidence>;

export const AuditCostDelta = z.object({
  tokensInput: z.number().int().nonnegative().optional(),
  tokensOutput: z.number().int().nonnegative().optional(),
  totalCostUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().nonnegative().optional(),
});
export type AuditCostDelta = z.infer<typeof AuditCostDelta>;

export const AuditScope = z.object({
  conversationId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  parentRunId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  agentSpecId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  metadata: JsonRecord.optional(),
});
export type AuditScope = z.infer<typeof AuditScope>;

/**
 * 标准审计信封。
 *
 * 中文备注：
 * - action 保持 string，以便 host 扩展自己的动作名；
 * - decision/evidence/costDelta 都是可选事实片段，避免把所有审计场景压成同一种形状；
 * - envelope 必须追加只读，更新/撤回应追加新的补偿 envelope。
 */
export const AuditEnvelope = z.object({
  envelopeId: z.string().min(1),
  runId: z.string().min(1),
  parentRunId: z.string().min(1).optional(),
  ts: z.number().int().nonnegative(),
  actor: AuditActor,
  action: z.string().min(1),
  decision: AuditDecision.optional(),
  evidence: z.array(AuditEvidence).optional(),
  costDelta: AuditCostDelta.optional(),
  scope: AuditScope.optional(),
});
export type AuditEnvelope = z.infer<typeof AuditEnvelope>;
