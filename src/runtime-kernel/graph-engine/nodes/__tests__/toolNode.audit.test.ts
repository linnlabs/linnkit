import { describe, expect, it, vi } from 'vitest';
import type { AuditPort } from '../../../../ports';
import type { EngineState, StandardToolCall } from '../../types';
import { ENGINE_STATE_SCHEMA_VERSION } from '../../types';
import type { ToolExecutionResult, ToolRuntimeDefinition } from '../../../tools/ports';
import { ToolNode } from '../toolNode';
import {
  MODEL_INPUT_ERROR_CODES,
  ModelInputCapabilityError,
} from '../../../llm/input-capabilities';
import { createRuntimeEventAdmissionSink } from './runtimeEventAdmissionFixture';
import { RunIdSchema, ToolCallIdSchema } from '../../../../contracts';
import { setLlmAuditRecorder } from '../../../../shared/llmAuditRecorder';

function buildCall(overrides: Partial<StandardToolCall> = {}): StandardToolCall {
  return {
    id: ToolCallIdSchema.parse('call_1'),
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
      runtimeEventSink: createRuntimeEventAdmissionSink('conv-audit', 'run-audit'),
      toolContext: {
        conversationId: 'conv-audit',
        turnId: 'turn-audit',
        runId: RunIdSchema.parse('run-audit'),
      },
    },
  };
}

const toolResultImageRequirement = {
  requires_image_input: true,
  placements: ['tool_result_image'] as const,
};

function buildAuditPort(): AuditPort & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn() };
}

const observationPreview = {
  truncateObservation: vi.fn().mockResolvedValue({ truncated: false }),
};

describe('ToolNode audit', () => {
  it('工具通过协议校验后、执行前发 tool.allow envelope', async () => {
    const auditPort = buildAuditPort();
    const exec: ToolExecutionResult = {
      success: true,
      result: '{"data":{},"observation":"ok"}',
      durationMs: 10,
    };
    const executeTool = vi.fn().mockImplementation(async () => {
      expect(auditPort.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tool.allow',
          decision: expect.objectContaining({
            outcome: 'allowed',
            reason: 'tool call passed protocol validation',
          }),
        })
      );
      return exec;
    });
    const node = new ToolNode({
      toolRuntime: {
        getToolDefinition: vi.fn().mockReturnValue(undefined),
        executeTool,
      },
      observationPreview,
      auditPort,
    });

    await node.run(buildState(buildCall()));

    expect(auditPort.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tool.allow',
        runId: 'run-audit',
        decision: expect.objectContaining({ outcome: 'allowed' }),
        evidence: [
          expect.objectContaining({
            kind: 'tool_call',
            ref: 'call_1',
          }),
        ],
        scope: expect.objectContaining({
          conversationId: 'conv-audit',
          turnId: 'turn-audit',
          runId: 'run-audit',
          toolName: 'echo',
          toolCallId: 'call_1',
        }),
      })
    );
    expect(auditPort.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          metadata: expect.not.objectContaining({ toolCallId: 'call_1' }),
        }),
      })
    );
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it('工具执行失败时保留 allow 的协议语义，不把执行错误写进 decision reason', async () => {
    const auditPort = buildAuditPort();
    const node = new ToolNode({
      toolRuntime: {
        getToolDefinition: vi.fn().mockReturnValue(undefined),
        executeTool: vi.fn().mockResolvedValue({
          success: false,
          error: 'SQLITE_CONSTRAINT: foreign key failed',
          errorKind: 'execution',
          durationMs: 4,
        } satisfies ToolExecutionResult),
      },
      observationPreview,
      auditPort,
    });

    await node.run(buildState(buildCall()));

    expect(auditPort.emit).toHaveBeenCalledTimes(1);
    expect(auditPort.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tool.allow',
        decision: expect.objectContaining({
          outcome: 'allowed',
          reason: 'tool call passed protocol validation',
        }),
      })
    );
    expect(auditPort.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ reason: expect.stringContaining('SQLITE_CONSTRAINT') }),
      })
    );
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

    await node.run(
      buildState(
        buildCall({
          function: { name: 'echo', arguments: 'not-json' },
        })
      )
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(auditPort.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tool.deny',
        decision: expect.objectContaining({
          outcome: 'denied',
          metadata: expect.objectContaining({ errorKind: 'protocol' }),
        }),
        evidence: [expect.objectContaining({ ref: 'call_1' })],
        scope: expect.objectContaining({ toolCallId: 'call_1' }),
      })
    );
    expect(auditPort.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tool.protocol_error',
        decision: expect.objectContaining({
          metadata: expect.not.objectContaining({ toolCallId: 'call_1' }),
        }),
        evidence: [expect.objectContaining({ ref: 'call_1' })],
        scope: expect.objectContaining({ toolCallId: 'call_1' }),
      })
    );
  });

  it('协议错误同时进入专用 LLM 审计 recorder', async () => {
    const recordToolProtocolError = vi.fn();
    setLlmAuditRecorder({ recordToolProtocolError });

    try {
      const node = new ToolNode({
        toolRuntime: {
          getToolDefinition: vi.fn().mockReturnValue(undefined),
          executeTool: vi.fn(),
        },
        observationPreview,
      });

      await node.run(
        buildState(
          buildCall({
            function: { name: 'ask', arguments: '{"questions":' },
          })
        )
      );

      expect(recordToolProtocolError).toHaveBeenCalledWith({
        toolName: 'ask',
        toolCallId: 'call_1',
        rawArguments: '{"questions":',
        parsedArguments: {},
        error: expect.stringContaining('Tool arguments are not valid JSON'),
      });
    } finally {
      setLlmAuditRecorder(null);
    }
  });

  it('owner 参数 admission 失败时不发布 tool_process，并配对 error output', async () => {
    const executeTool = vi.fn();
    const node = new ToolNode({
      toolRuntime: {
        getToolDefinition: vi.fn().mockReturnValue({
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'path' },
              inode: { type: 'string', description: 'inode' },
            },
          },
          validateArguments: () => ({
            success: false,
            error: 'read_file 参数不符合正式合同',
          }),
        } satisfies ToolRuntimeDefinition),
        executeTool,
      },
      observationPreview,
    });

    const result = await node.run(
      buildState(
        buildCall({
          function: { name: 'read_file', arguments: '{"path":"/x","inode":""}' },
        })
      )
    );

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.events?.filter(event => event.type === 'tool_process')).toHaveLength(0);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_output',
          tool_call_id: 'call_1',
          status: 'error',
          error: 'read_file 参数不符合正式合同',
        }),
      ])
    );
  });

  it('没有模型的 Host 主动调用直接执行，不做模型看图能力检查', async () => {
    const state = buildState(buildCall());
    if (state.local) state.local.executorLocal = { stepCount: 0 };
    const executeTool = vi.fn().mockResolvedValue({
      success: true,
      result: '{"data":{},"observation":"ok"}',
      durationMs: 1,
    } satisfies ToolExecutionResult);
    const node = new ToolNode({
      toolRuntime: {
        getToolDefinition: vi.fn().mockReturnValue({ parameters: { type: 'object', properties: {} } }),
        executeTool,
      },
      observationPreview,
    });

    const result = await node.run(state);

    expect(executeTool).toHaveBeenCalledOnce();
    expect(result.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_output', status: 'success' })])
    );
  });
});
