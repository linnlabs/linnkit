import { describe, expect, it, vi } from 'vitest';

import {
  createDefaultGraphExecutor,
  createGraphLoopHarness,
  createScriptedAiEngineHarness,
  createToolContextFixture,
} from '../index';
import type { GraphNode } from '../../runtime-kernel';
import type { ToolExecutionResult, ToolRuntimePort } from '../../runtime-kernel';

/**
 * linnkit 包内端到端 smoke：完整 graph loop 行为契约。
 *
 * 中文备注：
 * - 现有 host 侧 `graphLoop.integration.test.ts` 通过 Linnya 默认装配验证 agent 行为；
 * - 这里在 packages/linnkit 内部用最小 mock 重跑同一组核心场景，
 *   保证 testkit + runtime-kernel 公开面在不依赖 host 的前提下也能闭环；
 * - 一旦未来 PR-D 后 dryrun 镜像消失、内核重构破坏 graph 调度或 testkit seam，
 *   这组测试会在 packages/linnkit 内第一时间失败，作为 agent 行为永久回归门。
 */

type GraphLoopOptions = Parameters<typeof createGraphLoopHarness>[0];

interface PendingToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ScriptedDecision {
  toolCalls?: PendingToolCall[];
  finalAnswer?: string;
}

interface ScriptedLlmNodeOptions {
  decisions: ScriptedDecision[];
}

function createScriptedLlmNode(options: ScriptedLlmNodeOptions): {
  node: GraphNode;
  getInvocationCount(): number;
} {
  let invocationCount = 0;

  const node: GraphNode = {
    id: 'llm',
    async run(state) {
      const decision = options.decisions[invocationCount];
      invocationCount += 1;
      if (!decision) {
        throw new Error(`scripted llm node exhausted after ${invocationCount - 1} calls`);
      }

      state.local = {
        ...(state.local ?? {}),
      };

      if (decision.toolCalls && decision.toolCalls.length > 0) {
        state.local.pendingToolCalls = decision.toolCalls;
        return { kind: 'route', nextNodeId: 'tool', events: [] };
      }

      if (typeof decision.finalAnswer === 'string') {
        state.local.finalAnswer = decision.finalAnswer;
        return { kind: 'route', nextNodeId: 'answer', events: [] };
      }

      return { kind: 'yield', events: [] };
    },
  };

  return {
    node,
    getInvocationCount: () => invocationCount,
  };
}

interface MockToolRuntimeOptions {
  getResult: (toolName: string, args: Record<string, unknown>) => ToolExecutionResult;
}

interface MockToolRuntime {
  toolRuntime: ToolRuntimePort;
  executions: Array<{ toolName: string; args: Record<string, unknown> }>;
}

function createMockToolRuntime(options: MockToolRuntimeOptions): MockToolRuntime {
  const executions: Array<{ toolName: string; args: Record<string, unknown> }> = [];

  const toolRuntime: ToolRuntimePort = {
    getToolSchemas() {
      return [];
    },
    getToolDefinition(toolName: string) {
      return {
        name: toolName,
        description: `mock tool ${toolName}`,
        parameters: { type: 'object', properties: {}, required: [] },
      } as unknown as ReturnType<ToolRuntimePort['getToolDefinition']>;
    },
    getDisplayOptions() {
      return undefined;
    },
    async executeTool(toolName, args) {
      executions.push({ toolName, args });
      return options.getResult(toolName, args);
    },
  };

  return { toolRuntime, executions };
}

function createObservationPreviewStub(): GraphLoopOptions['observationPreview'] {
  return {
    async truncateObservation(params) {
      return {
        truncated: false,
        preview: params.text,
      };
    },
  };
}

function buildHarnessOptions(params: {
  llmNode: GraphNode;
  toolRuntime: ToolRuntimePort;
  signal?: AbortSignal;
  conversationId?: string;
  turnId?: string;
}): GraphLoopOptions {
  const conversationId = params.conversationId ?? 'conv_linnkit_e2e';
  const turnId = params.turnId ?? 'turn_linnkit_e2e';
  const aiHarness = createScriptedAiEngineHarness([]);
  const toolContext = createToolContextFixture({
    conversationId,
    turnId,
    historyEvents: [],
    patch: params.signal ? { abortSignal: params.signal } : undefined,
  });

  return {
    conversationId,
    turnId,
    query: '请执行端到端工具调用',
    request: {
      query: '请执行端到端工具调用',
      promptKey: 'linnkit-e2e-contract',
      mode: 'agent',
      enableTools: true,
      availableTools: ['mock_tool'],
    },
    toolContext,
    llmCaller: aiHarness.getLlmCaller(),
    toolRuntime: params.toolRuntime,
    observationPreview: createObservationPreviewStub(),
    createLlmNode: () => params.llmNode,
    maxSteps: 8,
    signal: params.signal,
  };
}

describe('linnkit testkit graph loop end-to-end smoke', () => {
  it('应跑通完整 LLM → Tool → LLM → Answer 链路（成功路径）', async () => {
    const { node: llmNode, getInvocationCount } = createScriptedLlmNode({
      decisions: [
        {
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'mock_tool',
                arguments: JSON.stringify({ query: 'hello' }),
              },
            },
          ],
        },
        {
          finalAnswer: '工具结果已合成最终答案',
        },
      ],
    });
    const { toolRuntime, executions } = createMockToolRuntime({
      getResult(toolName) {
        return {
          success: true,
          result: JSON.stringify({ observation: `mock observation from ${toolName}` }),
          durationMs: 1,
        };
      },
    });

    const harness = createGraphLoopHarness(
      buildHarnessOptions({ llmNode, toolRuntime }),
    );
    const result = await harness.run();

    expect(result.checkpointNodeId).toBe('answer');
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      toolName: 'mock_tool',
      args: { query: 'hello' },
    });
    expect(getInvocationCount()).toBe(2);
    expect(result.stepCount).toBeGreaterThan(3);
  });

  it('工具失败时应回到 LLM 节点继续推理并最终给出答案（错误恢复路径）', async () => {
    const { node: llmNode, getInvocationCount } = createScriptedLlmNode({
      decisions: [
        {
          toolCalls: [
            {
              id: 'call_err',
              type: 'function',
              function: {
                name: 'mock_tool',
                arguments: JSON.stringify({ should_fail: true }),
              },
            },
          ],
        },
        {
          finalAnswer: '工具失败后我也能给出兜底答案',
        },
      ],
    });
    const { toolRuntime, executions } = createMockToolRuntime({
      getResult() {
        return {
          success: false,
          error: 'simulated execution failure',
          errorKind: 'execution',
          durationMs: 1,
        };
      },
    });

    const harness = createGraphLoopHarness(
      buildHarnessOptions({ llmNode, toolRuntime }),
    );
    const result = await harness.run();

    expect(result.checkpointNodeId).toBe('answer');
    expect(executions).toHaveLength(1);
    expect(getInvocationCount()).toBe(2);
  });

  it('已 abort 的 signal 应让 ToolNode 抛 AbortError，graph loop 立刻终止', async () => {
    const { node: llmNode } = createScriptedLlmNode({
      decisions: [
        {
          toolCalls: [
            {
              id: 'call_abort',
              type: 'function',
              function: {
                name: 'mock_tool',
                arguments: JSON.stringify({}),
              },
            },
          ],
        },
      ],
    });
    const executeTool = vi.fn();
    const toolRuntime: ToolRuntimePort = {
      getToolSchemas: () => [],
      getToolDefinition: (toolName) => ({
        name: toolName,
        description: 'mock',
        parameters: { type: 'object', properties: {}, required: [] },
      } as unknown as ReturnType<ToolRuntimePort['getToolDefinition']>),
      getDisplayOptions: () => undefined,
      executeTool,
    };

    const controller = new AbortController();
    controller.abort();

    const harness = createGraphLoopHarness(
      buildHarnessOptions({ llmNode, toolRuntime, signal: controller.signal }),
    );

    await expect(harness.run()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('createDefaultGraphExecutor 与 createGraphLoopHarness 应共用同一图调度（最小 smoke）', async () => {
    const { node: llmNode } = createScriptedLlmNode({
      decisions: [
        {
          finalAnswer: '直答路径，无工具调用',
        },
      ],
    });
    const { toolRuntime } = createMockToolRuntime({
      getResult() {
        return { success: true, result: '{}', durationMs: 0 };
      },
    });

    const executor = createDefaultGraphExecutor({
      llmNode,
      toolRuntime,
      observationPreview: createObservationPreviewStub(),
      maxSteps: 4,
    });
    expect(executor).toBeDefined();

    const harness = createGraphLoopHarness(
      buildHarnessOptions({ llmNode, toolRuntime }),
    );
    const result = await harness.run();
    expect(result.checkpointNodeId).toBe('answer');
  });
});
