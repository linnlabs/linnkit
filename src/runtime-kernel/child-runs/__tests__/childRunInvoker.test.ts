import { describe, expect, it, vi } from 'vitest';
import type { AgentInvocationRequest } from '../../../ports/agent-invocation';
import type { EngineState, GraphNode, NodeResult } from '../../graph-engine/types';
import { ChildRunInvoker } from '../childRunInvoker';
import {
  ensureToolContextRuntimeCapability,
  getToolContextRuntimeBinding,
  readToolContextPersistedHistory,
  readToolContextWorkingHistory,
} from '../../tools/toolContextRuntime';
import type { ObservationPreviewPort, ToolRuntimeDefinition, ToolRuntimePort } from '../../tools/ports';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';
import type { AuditEnvelope } from '../../../contracts/audit';
import type { RuntimeEvent, UserInputEvent } from '../../../contracts';

const noopObservationPreview: ObservationPreviewPort = {
  async truncateObservation({ text }) {
    return { truncated: false, preview: text };
  },
};

const noopToolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'> = {
  getToolDefinition: () => undefined,
  async executeTool() {
    return { success: false, error: 'tool runtime not configured', durationMs: 0 };
  },
};

describe('ChildRunInvoker', () => {
  it('默认模型兜底应显式走 ModelResolver，而不是借道 LlmCaller', async () => {
    const capturedRequests: AgentInvocationRequest[] = [];
    const modelResolver = {
      resolveModelId: vi.fn(() => 'default-model-from-resolver'),
    };

    const llmNode: GraphNode = {
      id: 'llm',
      async run(state: EngineState): Promise<NodeResult> {
        const request = isAgentInvocationRequest(state.local?.request)
          ? state.local.request
          : undefined;
        if (request) {
          capturedRequests.push(request);
        }
        return { kind: 'yield', events: [] };
      },
    };

    const invoker = new ChildRunInvoker({
      modelResolver,
      createLlmNode: () => llmNode,
      toolRuntime: noopToolRuntime,
      observationPreview: noopObservationPreview,
      eventToMessageConverter: vi.fn(() => []),
    });

    await invoker.invoke({
      agentConfig: {
        id: 'internal-agent',
        promptKey: 'default',
      },
      userMessage: '继续执行',
      parentToolContext: {},
    });

    expect(modelResolver.resolveModelId).toHaveBeenCalledTimes(1);
    expect(capturedRequests[0]?.model_id).toBe('default-model-from-resolver');
  });

  it('应为 child ToolContext 显式建立独立 runtime binding，而不是继承父级 capability 表面', async () => {
    let capturedToolContext: Record<string, unknown> | undefined;
    const parentHistory = [
      {
        id: 'parent-user',
        type: 'user_input',
        conversation_id: 'parent-conversation',
        turn_id: 'parent-turn',
        timestamp: Date.now(),
        version: 1,
        source: 'user',
        content: 'parent history',
      } satisfies UserInputEvent,
    ];
    const seedHistory = [
      {
        id: 'seed-user',
        type: 'user_input',
        conversation_id: 'child-conversation',
        turn_id: 'child-turn',
        timestamp: Date.now(),
        version: 1,
        source: 'user',
        content: 'seed history',
      } satisfies UserInputEvent,
    ];
    const parentToolContext: Record<string, unknown> = {
      deepSearchDepth: 2,
      customService: { ok: true },
    };

    const parentBinding = ensureToolContextRuntimeCapability({
      context: parentToolContext,
      persistedHistory: parentHistory,
      workingHistory: parentHistory,
      executionMeta: {
        conversationId: 'parent-conversation',
        turnId: 'parent-turn',
        runId: 'parent-run',
        parentToolCallId: 'parent-tool-call',
        citationOffset: 9,
      },
    });

    const llmNode: GraphNode = {
      id: 'llm',
      async run(state: EngineState): Promise<NodeResult> {
        capturedToolContext = isRecord(state.local?.toolContext)
          ? state.local.toolContext
          : undefined;
        return { kind: 'yield', events: [] };
      },
    };

    const invoker = new ChildRunInvoker({
      modelResolver: { resolveModelId: vi.fn(() => 'default-model-from-resolver') },
      createLlmNode: () => llmNode,
      toolRuntime: noopToolRuntime,
      observationPreview: noopObservationPreview,
      eventToMessageConverter: vi.fn(() => []),
    });

    await invoker.invoke({
      agentConfig: {
        id: 'internal-agent',
        promptKey: 'default',
      },
      userMessage: '继续执行',
      parentToolContext,
      runId: 'child-run-1',
      parentRunId: 'parent-run',
      seedHistoryEvents: seedHistory,
    });

    expect(capturedToolContext).toBeDefined();
    const childToolContext = capturedToolContext as typeof parentToolContext;
    const childBinding = getToolContextRuntimeBinding(childToolContext);

    expect(childBinding).toBeDefined();
    expect(childBinding).not.toBe(parentBinding);
    expect(childToolContext.conversationView).not.toBe(parentToolContext.conversationView);
    expect(childToolContext.getConversationHistoryEvents).not.toBe(parentToolContext.getConversationHistoryEvents);
    expect(readToolContextPersistedHistory(childToolContext)).toBe(seedHistory);
    expect(readToolContextWorkingHistory(childToolContext)).toBe(seedHistory);
    expect(childToolContext.conversationId).toBe('parent-conversation');
    expect(childToolContext.turnId).toMatch(/^turn_/);
    expect(childToolContext.runId).toBe('child-run-1');
    expect(childToolContext.parentRunId).toBe('parent-run');
    expect(childToolContext.parentToolCallId).toBeUndefined();
    expect(childToolContext.citationOffset).toBeUndefined();
    expect(childToolContext.deepSearchDepth).toBe(3);
    expect(childToolContext.abortSignal).toBeUndefined();
    expect(childToolContext.customService).toBe(parentToolContext.customService);

    expect(readToolContextWorkingHistory(parentToolContext)).toBe(parentHistory);
    expect(parentToolContext.conversationId).toBe('parent-conversation');
    expect(parentToolContext.turnId).toBe('parent-turn');
    expect(parentToolContext.runId).toBe('parent-run');
    expect(parentToolContext.parentToolCallId).toBe('parent-tool-call');
    expect(parentToolContext.citationOffset).toBe(9);
  });

  it('应允许 host 显式指定 child-run 审计会话，同时继续用内部 checkpoint key 隔离执行状态', async () => {
    let capturedLlmConversationId: string | undefined;
    let capturedToolContext: ToolExecutionContext | undefined;
    const emittedAudit: AuditEnvelope[] = [];
    const emittedTelemetry: unknown[] = [];
    const childToolDefinition: ToolRuntimeDefinition = {
      parameters: { type: 'object', properties: {} },
    };
    const toolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'> = {
      getToolDefinition: vi.fn(() => childToolDefinition),
      executeTool: vi.fn(async (_toolName, _args, context) => {
        capturedToolContext = context;
        return {
          success: true,
          result: 'tool ok',
          durationMs: 1,
        };
      }),
    };

    const llmNode: GraphNode = {
      id: 'llm',
      async run(state: EngineState): Promise<NodeResult> {
        capturedLlmConversationId = typeof state.local?.conversationId === 'string'
          ? state.local.conversationId
          : undefined;
        state.local = {
          ...(state.local ?? {}),
          pendingToolCalls: [
            {
              id: 'call_child_tool',
              type: 'function',
              function: {
                name: 'child_tool',
                arguments: '{"value":"hello"}',
              },
            },
          ],
        };
        return { kind: 'route', nextNodeId: 'tool', events: [] };
      },
    };

    const invoker = new ChildRunInvoker({
      modelResolver: { resolveModelId: vi.fn(() => 'default-model-from-resolver') },
      createLlmNode: () => llmNode,
      toolRuntime,
      observationPreview: noopObservationPreview,
      eventToMessageConverter: vi.fn(() => []),
      telemetryPort: {
        emit: vi.fn((event) => {
          emittedTelemetry.push(event);
        }),
      },
      auditPort: {
        emit: vi.fn(async (envelope: AuditEnvelope) => {
          emittedAudit.push(envelope);
        }),
      },
    });

    const result = await invoker.invoke({
      agentConfig: {
        id: 'internal-agent',
        promptKey: 'default',
        availableTools: ['child_tool'],
      },
      userMessage: '调用子工具',
      parentToolContext: {
        conversationId: 'parent-conversation',
        runId: 'parent-run',
      },
      conversationId: 'registered-conversation',
      runId: 'child-run-1',
      parentRunId: 'parent-run',
      maxSteps: 3,
    });

    expect(result.success).toBe(true);
    expect(result.events.some((event) => event.type === 'tool_output')).toBe(true);
    expect(capturedLlmConversationId).toBe('registered-conversation');
    expect(capturedToolContext?.conversationId).toBe('registered-conversation');
    expect(capturedToolContext?.runId).toBe('child-run-1');
    expect(capturedToolContext?.parentRunId).toBe('parent-run');
    expect(
      emittedTelemetry
        .filter(isTelemetryWithScope)
        .filter((event) => event.kind === 'run_lifecycle' || event.kind === 'graph_node')
        .every((event) => event.scope.conversationId === 'registered-conversation'),
    ).toBe(true);
    expect(emittedAudit).toEqual([
      expect.objectContaining({
        action: 'tool.allow',
        runId: 'child-run-1',
        parentRunId: 'parent-run',
        scope: expect.objectContaining({
          conversationId: 'registered-conversation',
          runId: 'child-run-1',
          parentRunId: 'parent-run',
          toolName: 'child_tool',
        }),
      }),
    ]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAgentInvocationRequest(value: unknown): value is AgentInvocationRequest {
  return isRecord(value) && typeof value.query === 'string' && typeof value.promptKey === 'string';
}

function isTelemetryWithScope(value: unknown): value is {
  kind: string;
  scope: { conversationId?: string };
} {
  return isRecord(value) && typeof value.kind === 'string' && isRecord(value.scope);
}
