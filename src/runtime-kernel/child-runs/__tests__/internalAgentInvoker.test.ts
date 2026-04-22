import { describe, expect, it, vi } from 'vitest';
import type { AgentInvocationRequest } from '../../../ports/agent-invocation';
import type { GraphNode } from '../../graph-engine/types';
import { InternalAgentInvoker } from '../internalAgentInvoker';
import {
  ensureToolContextRuntimeCapability,
  getToolContextRuntimeBinding,
  readToolContextPersistedHistory,
  readToolContextWorkingHistory,
} from '../../tools/toolContextRuntime';
import type { ObservationPreviewPort } from '../../tools/ports';
import type { RuntimeEvent, UserInputEvent } from '../../../contracts';

const noopObservationPreview: ObservationPreviewPort = {
  truncateObservation: vi.fn(async ({ text }) => ({ truncated: false, preview: text })),
};

describe('InternalAgentInvoker', () => {
  it('默认模型兜底应显式走 ModelResolver，而不是借道 LlmCaller', async () => {
    const capturedRequests: AgentInvocationRequest[] = [];
    const modelResolver = {
      resolveModelId: vi.fn(() => 'default-model-from-resolver'),
    };

    const llmNode: GraphNode = {
      id: 'llm',
      run: vi.fn(async (state) => {
        const request = state.local?.request as AgentInvocationRequest | undefined;
        if (request) {
          capturedRequests.push(request);
        }
        return { kind: 'yield', events: [] };
      }),
    };

    const invoker = new InternalAgentInvoker({
      modelResolver,
      createLlmNode: () => llmNode,
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
        content: 'parent history',
      } satisfies UserInputEvent,
    ] as RuntimeEvent[];
    const seedHistory = [
      {
        id: 'seed-user',
        type: 'user_input',
        conversation_id: 'child-conversation',
        turn_id: 'child-turn',
        content: 'seed history',
      } satisfies UserInputEvent,
    ] as RuntimeEvent[];
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
        parentToolCallId: 'parent-tool-call',
        citationOffset: 9,
      },
    });

    const llmNode: GraphNode = {
      id: 'llm',
      run: vi.fn(async (state) => {
        capturedToolContext = (state.local?.toolContext as Record<string, unknown> | undefined) ?? undefined;
        return { kind: 'yield', events: [] };
      }),
    };

    const invoker = new InternalAgentInvoker({
      modelResolver: { resolveModelId: vi.fn(() => 'default-model-from-resolver') },
      createLlmNode: () => llmNode,
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
    expect(childToolContext.parentToolCallId).toBeUndefined();
    expect(childToolContext.citationOffset).toBeUndefined();
    expect(childToolContext.deepSearchDepth).toBe(3);
    expect(childToolContext.abortSignal).toBeUndefined();
    expect(childToolContext.customService).toBe(parentToolContext.customService);

    expect(readToolContextWorkingHistory(parentToolContext)).toBe(parentHistory);
    expect(parentToolContext.conversationId).toBe('parent-conversation');
    expect(parentToolContext.turnId).toBe('parent-turn');
    expect(parentToolContext.parentToolCallId).toBe('parent-tool-call');
    expect(parentToolContext.citationOffset).toBe(9);
  });
});
