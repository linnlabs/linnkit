import type {
  AuditActor,
  AuditCostDelta,
  AuditDecision,
  AuditEvidence,
  AuditScope,
} from '../../contracts';
import type { AuditPort } from '../../ports';
import { generateAuditEnvelopeId } from '../../shared/ids';

export interface EmitAuditEnvelopeParams {
  runId?: string;
  parentRunId?: string;
  actor?: AuditActor;
  action: string;
  decision?: AuditDecision;
  evidence?: AuditEvidence[];
  costDelta?: AuditCostDelta;
  scope: AuditScope;
}

function resolveRunId(params: EmitAuditEnvelopeParams): string {
  const runId = params.runId ?? params.scope.runId ?? params.scope.turnId;
  if (typeof runId === 'string' && runId.trim().length > 0) {
    return runId;
  }
  throw new Error(`Audit action ${params.action} requires runId or scope.turnId`);
}

/**
 * 统一发出 AuditEnvelope。
 *
 * 中文备注：
 * - 调用点只描述“谁做了什么决策”，这里统一补 envelopeId / ts / runId；
 * - 不吞 emit 异常，审计链路异常应由上层测试或 host 策略显式处理。
 */
export async function emitAuditEnvelope(
  auditPort: AuditPort,
  params: EmitAuditEnvelopeParams,
): Promise<void> {
  const runId = resolveRunId(params);
  await auditPort.emit({
    envelopeId: generateAuditEnvelopeId(),
    runId,
    parentRunId: params.parentRunId ?? params.scope.parentRunId,
    ts: Date.now(),
    actor: params.actor ?? { kind: 'system' },
    action: params.action,
    decision: params.decision,
    evidence: params.evidence,
    costDelta: params.costDelta,
    scope: {
      ...params.scope,
      runId,
    },
  });
}

export async function emitSandboxDecisionAudit(
  auditPort: AuditPort,
  params: {
    scope: AuditScope;
    allowed: boolean;
    reason?: string;
    policy?: string;
    evidence?: AuditEvidence[];
  },
): Promise<void> {
  await emitAuditEnvelope(auditPort, {
    action: 'sandbox.decide',
    actor: { kind: 'system' },
    decision: {
      outcome: params.allowed ? 'allowed' : 'denied',
      reason: params.reason,
      policy: params.policy,
    },
    evidence: params.evidence,
    scope: params.scope,
  });
}
