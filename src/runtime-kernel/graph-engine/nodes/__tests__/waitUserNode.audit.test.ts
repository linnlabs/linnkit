import { describe, expect, it, vi } from 'vitest';
import type { AuditPort } from '../../../../ports';
import type { EngineState } from '../../types';
import { ENGINE_STATE_SCHEMA_VERSION } from '../../types';
import { WaitUserNode } from '../waitUserNode';

function buildAuditPort(): AuditPort & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() };
}

describe('WaitUserNode audit', () => {
  it('进入 wait_user 时发 wait_user.request envelope', async () => {
    const auditPort = buildAuditPort();
    const node = new WaitUserNode({ auditPort });
    const state: EngineState = {
      nodeId: 'wait_user',
      schemaVersion: ENGINE_STATE_SCHEMA_VERSION,
      local: {
        conversationId: 'conv-wait',
        turnId: 'turn-wait',
        pendingInteractionSpec: {
          prompt: '需要用户确认',
        },
        toolContext: {
          runId: 'run-wait',
        },
      },
    };

    const result = await node.run(state);

    expect(result.kind).toBe('pause');
    expect(result.events).toEqual([
      expect.objectContaining({
        type: 'requires_user_interaction',
        id: expect.any(String),
        metadata: expect.objectContaining({
          run_context: {
            runId: 'run-wait',
          },
        }),
      }),
    ]);
    expect(auditPort.emit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'wait_user.request',
      runId: 'run-wait',
      decision: expect.objectContaining({ outcome: 'requested' }),
      scope: expect.objectContaining({
        conversationId: 'conv-wait',
        turnId: 'turn-wait',
        runId: 'run-wait',
      }),
    }));
  });
});
