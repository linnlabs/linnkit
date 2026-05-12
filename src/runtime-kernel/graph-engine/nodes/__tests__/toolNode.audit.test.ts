import { describe, expect, it, vi } from 'vitest';
import type { AuditPort } from '../../../../ports';
import type { EngineState, StandardToolCall } from '../../types';
import { ENGINE_STATE_SCHEMA_VERSION } from '../../types';
import type { ToolExecutionResult } from '../../../tools/ports';
import { ToolNode } from '../toolNode';

function buildCall(overrides: Partial<StandardToolCall> = {}): StandardToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: {
      name: 'echo',
      arguments: '{"text":"hi"}',
    },
    ...overrides,
  };
}

function buildState(call: StandardToolCall): EngineState {
  return {
    nodeId: 'tool',
    schemaVersion: ENGINE_STATE_SCHEMA_VERSION,
    local: {
      pendingToolCalls: [call],
      conversationId: 'conv-audit',
      turnId: 'turn-audit',
      history: [],
      toolContext: {
        conversationId: 'conv-audit',
        turnId: 'turn-audit',
        runId: 'run-audit',
      },
    },
  };
}

function buildAuditPort(): AuditPort & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() };
}

const observationPreview = {
  truncateObservation: vi.fn().mockResolvedValue({ truncated: false }),
};

describe('ToolNode audit', () => {
  it('工具执行成功时发 tool.allow envelope', async () => {
    const auditPort = buildAuditPort();
    const exec: ToolExecutionResult = {
      success: true,
      result: '{"observation":"ok"}',
      durationMs: 10,
    };
    const node = new ToolNode({
      toolRuntime: {
        getToolDefinition: vi.fn().mockReturnValue(undefined),
        executeTool: vi.fn().mockResolvedValue(exec),
      },
      observationPreview,
      auditPort,
    });

    await node.run(buildState(buildCall()));

    expect(auditPort.emit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tool.allow',
      runId: 'run-audit',
      decision: expect.objectContaining({ outcome: 'allowed' }),
      scope: expect.objectContaining({
        conversationId: 'conv-audit',
        turnId: 'turn-audit',
        runId: 'run-audit',
        toolName: 'echo',
        toolCallId: 'call_1',
      }),
    }));
  });

  it('协议错误时发 tool.deny envelope 且不执行工具', async () => {
    const auditPort = buildAuditPort();
    const executeTool = vi.fn();
    const node = new ToolNode({
      toolRuntime: {
        getToolDefinition: vi.fn().mockReturnValue(undefined),
        executeTool,
      },
      observationPreview,
      auditPort,
    });

    await node.run(buildState(buildCall({
      function: { name: 'echo', arguments: 'not-json' },
    })));

    expect(executeTool).not.toHaveBeenCalled();
    expect(auditPort.emit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tool.deny',
      decision: expect.objectContaining({
        outcome: 'denied',
        metadata: expect.objectContaining({ errorKind: 'protocol' }),
      }),
    }));
  });
});
