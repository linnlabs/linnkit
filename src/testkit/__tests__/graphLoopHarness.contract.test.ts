import { describe, expect, it } from 'vitest';

import {
  createDefaultGraphExecutor,
  createGraphLoopHarness,
  createScriptedAiEngineHarness,
  createToolContextFixture,
} from '../index';

describe('src/agent/testkit graph loop harness contract', () => {
  it('exposes createGraphLoopHarness as part of the public testkit surface', async () => {
    const moduleUnderTest = await import('../index');

    expect(moduleUnderTest.createGraphLoopHarness).toBeTypeOf('function');
    expect(moduleUnderTest.createDefaultGraphExecutor).toBeTypeOf('function');
  });

  it('creates a default graph executor through the public testkit seam', () => {
    const llmNode = {
      id: 'llm',
      async run() {
        return { kind: 'route' as const, nextNodeId: 'answer', events: [] };
      },
    };
    const toolRuntime: Parameters<typeof createGraphLoopHarness>[0]['toolRuntime'] = {
      getToolSchemas() {
        return [];
      },
      getToolDefinition() {
        return undefined;
      },
      getDisplayOptions() {
        return undefined;
      },
      async executeTool() {
        throw new Error('default graph executor seam test did not expect tool execution');
      },
    };
    const observationPreview: Parameters<typeof createGraphLoopHarness>[0]['observationPreview'] = {
      async truncateObservation(params) {
        return {
          truncated: false,
          preview: params.text,
        };
      },
    };

    const executor = createDefaultGraphExecutor({
      llmNode,
      toolRuntime,
      observationPreview,
      maxSteps: 4,
    });

    expect(executor).toBeDefined();
  });

  it('runs the agent-owned graph loop internals behind the public testkit seam', async () => {
    type GraphLoopOptions = Parameters<typeof createGraphLoopHarness>[0];

    const conversationId = 'conv_public_graph_loop_contract';
    const turnId = 'turn_public_graph_loop_contract';
    const aiHarness = createScriptedAiEngineHarness([]);
    const toolContext = createToolContextFixture({
      conversationId,
      turnId,
      historyEvents: [],
    });
    const toolRuntime: GraphLoopOptions['toolRuntime'] = {
      getToolSchemas() {
        return [];
      },
      getToolDefinition() {
        return undefined;
      },
      getDisplayOptions() {
        return undefined;
      },
      async executeTool() {
        throw new Error('graph loop contract test did not expect tool execution');
      },
    };
    const observationPreview: GraphLoopOptions['observationPreview'] = {
      async truncateObservation(params) {
        return {
          truncated: false,
          preview: params.text,
        };
      },
    };

    const harness = createGraphLoopHarness({
      conversationId,
      turnId,
      query: 'hello graph loop',
      request: {
        query: 'hello graph loop',
        promptKey: 'contract-test',
        mode: 'agent',
        enableTools: false,
        availableTools: [],
      },
      toolContext,
      llmCaller: aiHarness.getLlmCaller(),
      toolRuntime,
      observationPreview,
      createLlmNode: () => ({
        id: 'llm',
        async run(state) {
          state.local = {
            ...(state.local ?? {}),
            finalAnswer: 'public graph loop seam answered',
          };
          return { kind: 'route', nextNodeId: 'answer', events: [] };
        },
      }),
      maxSteps: 4,
    });

    const result = await harness.run();

    expect(result).toEqual({
      checkpointNodeId: 'answer',
      stepCount: 3,
    });
    aiHarness.assertAllTurnsConsumed();
  });
});
