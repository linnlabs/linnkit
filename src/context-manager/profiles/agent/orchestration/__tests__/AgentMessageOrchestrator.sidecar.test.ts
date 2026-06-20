import { describe, expect, it } from 'vitest';

import type { AiMessage, RuntimeEvent, TokenRoute } from '../../../../../contracts';
import { defineContextPolicy } from '../../../../../contracts';
import type { TokenCounterPort } from '../../../../../ports';
import type { IAgentTask } from '../../tasks/base';
import type { MessageProcessingState, ProviderContext, ProviderResult } from '../../context/providers';
import {
  AgentCoreContextProvider,
  AgentWorkingMemoryProvider,
  ContextProviderRegistry,
} from '../../context/providers';
import { AgentMessageOrchestrator } from '../AgentMessageOrchestrator';
import { ToolManager, type ToolManagerRegistry } from '../../tools/ToolManager';
import {
  contextPolicyToContextBuilderConfig,
  contextPolicyToProviderOptions,
} from '../../../../shared/agentSpecAdapter';

const keepAllProvider = {
  name: 'KeepAllProvider',
  description: '测试用：保留所有预处理后的消息',
  priority: 0,
  async provide(
    states: MessageProcessingState[],
    _availableBudget: number,
    _context: ProviderContext,
  ): Promise<ProviderResult> {
    return {
      states: states.map((state) => ({ ...state, action: 'keep_working_memory' })),
      tokensUsed: 0,
      strategiesApplied: ['keep_all_for_test'],
      stats: {
        processedCount: states.length,
        skippedCount: 0,
        addedCount: 0,
      },
    };
  },
};

const passThroughTask: IAgentTask = {
  name: 'pass-through',
  buildMessages(request, history): AiMessage[] {
    return [
      ...history,
      {
        id: 'current_user',
        role: 'user',
        type: 'user_input',
        content: request.query,
        timestamp: 2000,
      },
    ];
  },
  processResponse(rawResponse: string): string {
    return rawResponse;
  },
  processStreamChunk(chunk: string): string {
    return chunk;
  },
};

const testToolRegistry: ToolManagerRegistry = {
  getTool: () => undefined,
  getAvailableToolNames: () => ['workspace_read'],
  validateToolCall: () => ({ success: true }),
};

function createOrchestrator(): AgentMessageOrchestrator {
  const providerRegistry = new ContextProviderRegistry();
  providerRegistry.register(keepAllProvider);

  return new AgentMessageOrchestrator({
    tokenBudget: {
      maxTokens: 100_000,
      reservedForResponse: 1000,
    },
    processing: {
      debugMode: false,
    },
    taskResolver: () => passThroughTask,
    providerRegistry,
  });
}

function createMissingSidecarHistory(): RuntimeEvent[] {
  return [
    {
      type: 'user_input',
      id: 'old_user',
      conversation_id: 'conv_orchestrator_sidecar',
      turn_id: 'turn_old',
      timestamp: 1000,
      version: 1,
      content: '先读文档',
      source: 'user',
    } as RuntimeEvent,
    {
      type: 'tool_call_decision',
      id: 'decision_missing_sidecar',
      conversation_id: 'conv_orchestrator_sidecar',
      turn_id: 'turn_old',
      timestamp: 1100,
      version: 1,
      tool_name: 'workspace_read',
      tool_call_id: 'call_missing_sidecar',
      phase: 'start',
      status: 'loading',
      payload: {
        tool_calls: [
          {
            id: 'call_missing_sidecar',
            type: 'function',
            function: {
              name: 'workspace_read',
              arguments: JSON.stringify({ path: 'README.md' }),
            },
          },
        ],
      },
    } as RuntimeEvent,
    {
      type: 'tool_output',
      id: 'tool_output_missing_sidecar',
      conversation_id: 'conv_orchestrator_sidecar',
      turn_id: 'turn_old',
      timestamp: 1200,
      version: 1,
      tool_name: 'workspace_read',
      tool_call_id: 'call_missing_sidecar',
      status: 'success',
      output: '{"observation":"README 内容"}',
    } as RuntimeEvent,
  ];
}

describe('AgentMessageOrchestrator provider sidecar policy', () => {
  it('不应在 linnkit 内根据 model_id 猜测 provider policy', async () => {
    const result = await createOrchestrator().processAgentConversation(
      {
        query: '继续',
        promptKey: 'default',
        model_id: 'cloud-deepseek-v4-flash',
      },
      createMissingSidecarHistory(),
      new ToolManager(testToolRegistry),
    );

    expect(result.messages.some((message) => message.type === 'tool_calls')).toBe(true);
    expect(result.messages.some((message) => message.type === 'tool_output')).toBe(true);
    expect(result.messages.some((message) => message.metadata?.isDegradedToolReplay === true)).toBe(false);
  });

  it('应使用下游注入的 tool replay protocol policy 触发历史工具组协议守卫', async () => {
    const providerRegistry = new ContextProviderRegistry();
    providerRegistry.register(keepAllProvider);
    const orchestrator = new AgentMessageOrchestrator({
      tokenBudget: {
        maxTokens: 100_000,
        reservedForResponse: 1000,
      },
      processing: {
        debugMode: false,
      },
      taskResolver: () => passThroughTask,
      providerRegistry,
      resolveToolReplayProtocolPolicy: ({ modelId }) => modelId === 'cloud-deepseek-v4-flash'
        ? {
            provider: 'deepseek',
            requiresReasoningDetailsForToolReplay: true,
            missingSidecarBehavior: 'degrade_to_text',
          }
        : undefined,
    });

    const result = await orchestrator.processAgentConversation(
      {
        query: '继续',
        promptKey: 'default',
        model_id: 'cloud-deepseek-v4-flash',
      },
      createMissingSidecarHistory(),
      new ToolManager(testToolRegistry),
    );

    expect(result.messages.some((message) => message.type === 'tool_calls')).toBe(false);
    expect(result.messages.some((message) => message.type === 'tool_output')).toBe(false);
    expect(result.messages.some((message) => message.metadata?.isDegradedToolReplay === true)).toBe(true);
  });

  it('request contextPolicy.providerReplay 应覆盖模型默认 sidecar replay 策略', async () => {
    const providerRegistry = new ContextProviderRegistry();
    providerRegistry.register(keepAllProvider);
    const orchestrator = new AgentMessageOrchestrator({
      tokenBudget: {
        maxTokens: 100_000,
        reservedForResponse: 1000,
      },
      processing: {
        debugMode: false,
      },
      taskResolver: () => passThroughTask,
      providerRegistry,
      resolveContextPolicy: () => defineContextPolicy({
        providerReplay: {
          missingSidecarBehavior: 'allow',
        },
      }),
      resolveToolReplayProtocolPolicy: () => ({
        provider: 'deepseek',
        requiresReasoningDetailsForToolReplay: true,
        missingSidecarBehavior: 'degrade_to_text',
      }),
    });

    const result = await orchestrator.processAgentConversation(
      {
        query: '继续',
        promptKey: 'default',
        model_id: 'cloud-deepseek-v4-flash',
      },
      createMissingSidecarHistory(),
      new ToolManager(testToolRegistry),
    );

    expect(result.messages.some((message) => message.type === 'tool_calls')).toBe(true);
    expect(result.messages.some((message) => message.type === 'tool_output')).toBe(true);
    expect(result.messages.some((message) => message.metadata?.isDegradedToolReplay === true)).toBe(false);
  });
});

describe('AgentMessageOrchestrator contextPolicy provider registry', () => {
  it('按 request 的 mustKeep policy 重建 provider registry，并保留指定 fence', async () => {
    const task: IAgentTask = {
      ...passThroughTask,
      buildMessages(request): AiMessage[] {
        return [
          {
            id: 'fence_1',
            role: 'user',
            type: 'context_injection',
            content: '需要保留的上下文',
            timestamp: 1500,
            metadata: {
              fenceKind: 'additional-context',
            },
          },
          {
            id: 'current_user',
            role: 'user',
            type: 'user_input',
            content: request.query,
            timestamp: 2000,
          },
        ];
      },
    };
    const initialRegistry = new ContextProviderRegistry();
    const orchestrator = new AgentMessageOrchestrator({
      tokenBudget: {
        maxTokens: 100_000,
        reservedForResponse: 1000,
      },
      processing: {
        debugMode: false,
      },
      taskResolver: () => task,
      providerRegistry: initialRegistry,
      resolveContextPolicy: () => defineContextPolicy({
        mustKeep: {
          alwaysKeepFenceKinds: ['additional-context'],
        },
      }),
      createProviderRegistry: ({ contextPolicy }) => {
        const registry = new ContextProviderRegistry();
        registry.register(new AgentCoreContextProvider({
          mustKeepPolicy: contextPolicyToProviderOptions(contextPolicy).mustKeep,
        }));
        return registry;
      },
    });

    const result = await orchestrator.processAgentConversation(
      {
        query: '继续',
        promptKey: 'default',
      },
      [],
      new ToolManager(testToolRegistry),
    );

    expect(result.messages.map((message) => message.id)).toContain('fence_1');
    expect(result.messages.map((message) => message.id)).toContain('current_user');
  });

  it('按 request 的 workingMemory policy 重建 provider registry，并限制历史工具组', async () => {
    const makeToolPair = (index: number): AiMessage[] => {
      const toolCallId = `call_${index}`;
      return [
        {
          id: `tool_calls_${index}`,
          role: 'assistant',
          type: 'tool_calls',
          content: '',
          timestamp: 1000 + index * 10,
          metadata: {
            tool_calls: [
              {
                id: toolCallId,
                type: 'function',
                function: {
                  name: 'workspace_read',
                  arguments: JSON.stringify({ path: `doc_${index}.md` }),
                },
              },
            ],
          },
        },
        {
          id: `tool_output_${index}`,
          role: 'tool',
          type: 'tool_output',
          content: `工具结果 ${index}`,
          timestamp: 1000 + index * 10 + 1,
          metadata: {
            tool_call_id: toolCallId,
            tool_name: 'workspace_read',
          },
        },
      ];
    };
    const task: IAgentTask = {
      ...passThroughTask,
      buildMessages(request): AiMessage[] {
        return [
          ...makeToolPair(1),
          ...makeToolPair(2),
          {
            id: 'current_user',
            role: 'user',
            type: 'user_input',
            content: request.query,
            timestamp: 2000,
          },
        ];
      },
    };
    const initialRegistry = new ContextProviderRegistry();
    const orchestrator = new AgentMessageOrchestrator({
      tokenBudget: {
        maxTokens: 100_000,
        reservedForResponse: 1000,
      },
      processing: {
        debugMode: false,
      },
      taskResolver: () => task,
      providerRegistry: initialRegistry,
      resolveContextPolicy: () => defineContextPolicy({
        toolHistory: {
          maxInteractionGroups: 1,
        },
        workingMemory: {
          maxRecentToolInteractions: 1,
          minToolInteractionsToKeep: 0,
        },
      }),
      createProviderRegistry: ({ contextPolicy }) => {
        const registry = new ContextProviderRegistry();
        registry.register(new AgentWorkingMemoryProvider(
          contextPolicy ? contextPolicyToContextBuilderConfig(contextPolicy) : {},
        ));
        return registry;
      },
    });

    const result = await orchestrator.processAgentConversation(
      {
        query: '继续',
        promptKey: 'default',
      },
      [],
      new ToolManager(testToolRegistry),
    );
    const ids = result.messages.map((message) => message.id);

    expect(ids).not.toContain('tool_calls_1');
    expect(ids).not.toContain('tool_output_1');
    expect(ids).toEqual(expect.arrayContaining(['tool_calls_2', 'tool_output_2']));
  });

  it('使用 contextPolicy.budget 作为本次上下文构建的有效预算', async () => {
    const providerRegistry = new ContextProviderRegistry();
    providerRegistry.register(keepAllProvider);
    const orchestrator = new AgentMessageOrchestrator({
      tokenBudget: {
        maxTokens: 10_000,
        reservedForResponse: 1000,
      },
      processing: {
        debugMode: false,
      },
      taskResolver: () => passThroughTask,
      providerRegistry,
      resolveContextPolicy: () => defineContextPolicy({
        budget: {
          maxTokens: 20_000,
          reservedForResponse: 3000,
        },
        contextTrace: {
          enabled: true,
        },
      }),
    });

    const result = await orchestrator.processAgentConversation(
      {
        query: '测试预算覆盖',
        promptKey: 'default',
      },
      [],
      new ToolManager(testToolRegistry),
    );

    expect(result.metadata.tokenUsage.budget).toBe(17_000);
    expect(result.contextBuildResult.contextTrace?.totalBudget).toBe(17_000);
    expect(result.contextBuildResult.contextTrace?.effectivePolicy?.budget?.maxTokens).toBe(20_000);
  });

  it('按 resolveTokenRoute 注入 route-aware TokenCounterPort，不按模型名猜 route', async () => {
    const route: TokenRoute = {
      providerId: 'anthropic',
      baseURL: 'https://api.linnyai.com/proxy/anthropic',
      modelId: 'cloud:claude-sonnet-4-6',
      providerModelId: 'claude-sonnet-4-6',
      capabilities: {
        supportsRemoteTokenCount: true,
      },
    };
    const calls: Array<Parameters<TokenCounterPort['countMessages']>[0]> = [];
    const tokenCounter: TokenCounterPort = {
      countMessages: async (input) => {
        calls.push(input);
        return {
          inputTokens: 123,
          source: 'test-fixture',
          confidence: 'provider-estimate',
        };
      },
    };
    const providerRegistry = new ContextProviderRegistry();
    providerRegistry.register(keepAllProvider);
    const orchestrator = new AgentMessageOrchestrator({
      tokenBudget: {
        maxTokens: 100_000,
        reservedForResponse: 1000,
      },
      processing: {
        debugMode: false,
      },
      taskResolver: () => passThroughTask,
      providerRegistry,
      tokenCounter,
      resolveTokenRoute: ({ modelId }) => modelId === 'cloud:claude-sonnet-4-6' ? route : undefined,
      resolveContextPolicy: () => defineContextPolicy({
        tokenEstimation: {
          remoteCount: {
            enabled: true,
          },
        },
        contextTrace: {
          enabled: true,
        },
      }),
    });

    const result = await orchestrator.processAgentConversation(
      {
        query: '继续',
        promptKey: 'default',
        model_id: 'cloud:claude-sonnet-4-6',
      },
      [],
      new ToolManager(testToolRegistry),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toEqual(route);
    expect(result.metadata.tokenUsage.estimated).toBe(123);
    expect(result.contextBuildResult.contextTrace?.remoteTokenCount).toMatchObject({
      enabled: true,
      attempted: true,
      applied: true,
      route,
      inputTokens: 123,
    });
  });
});
