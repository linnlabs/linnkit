import { GraphNode, EngineState, NodeResult } from '../types';
import { generateMessageId } from '../../../shared/ids';
import { createSSERequiresUserInteractionEvent } from '@app/schemas';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function buildResumeRequestSnapshot(request: unknown): Record<string, unknown> | undefined {
  if (!isRecord(request)) return undefined;

  const snapshot: Record<string, unknown> = {};
  const promptKey = toNonEmptyString(request['promptKey']);
  const mode = toNonEmptyString(request['mode']);
  const projectMetadata = request['project_metadata'];
  const documentMetadata = request['document_metadata'];
  const knowledgeBaseId = toNonEmptyString(request['knowledgeBaseId']);
  const availableTools = toStringArray(request['availableTools']);

  if (promptKey) snapshot['promptKey'] = promptKey;
  if (mode) snapshot['mode'] = mode;
  if (isRecord(projectMetadata)) snapshot['project_metadata'] = projectMetadata;
  if (isRecord(documentMetadata)) snapshot['document_metadata'] = documentMetadata;
  if (knowledgeBaseId) snapshot['knowledgeBaseId'] = knowledgeBaseId;
  if (typeof request['enableTools'] === 'boolean') snapshot['enableTools'] = request['enableTools'];
  if (availableTools) snapshot['availableTools'] = availableTools;

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

export class WaitUserNode implements GraphNode {
  id = 'wait_user';

  async run(state: EngineState): Promise<NodeResult> {
    const local: Record<string, unknown> = state.local || {};
    const spec = local.pendingInteractionSpec || {};
    const conversationId = typeof local.conversationId === 'string' ? (local.conversationId as string) : '';
    const turnId =
      typeof local.turnId === 'string'
        ? (local.turnId as string)
        : `turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    local.turnId = turnId;
    const sseSink = typeof local.sseSink === 'function' ? (local.sseSink as (evt: unknown) => void) : undefined;
    const resumeRequestSnapshot = buildResumeRequestSnapshot(local.request);

    const timestamp = Date.now();
    const id = generateMessageId();
    const sse = createSSERequiresUserInteractionEvent(id, conversationId, turnId, {
      timestamp,
      form: spec as Record<string, unknown>,
    });
    sse.timestamp = timestamp;
    if (sseSink) {
      try {
        Object.defineProperty(sse, '__dispatched_via_sse__', {
          value: true,
          enumerable: false,
          configurable: true,
        });
        sseSink(sse);
      } catch (error) {
        console.warn('[WaitUserNode] SSE dispatch failed:', error);
      }
    }

    const runtimeEvent = {
      type: 'requires_user_interaction' as const,
      id,
      conversation_id: conversationId,
      turn_id: turnId,
      timestamp,
      version: 1 as const,
      form: spec,
      metadata: resumeRequestSnapshot
        ? {
            resume_request_snapshot: resumeRequestSnapshot,
          }
        : undefined,
    };

    state.local = {
      ...local,
      pendingInteractionSpec: undefined,
      lastToolResult: undefined,
      conversationId,
      turnId,
    };
    return { kind: 'pause', events: [runtimeEvent] };
  }
}
