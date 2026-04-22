import { describe, expect, it } from 'vitest';
import type { AgentInvocationRequest } from '../../../../ports/agent-invocation';
import { runTickPipeline } from '../runTickPipeline';
import type {
  TickAroundMiddleware,
  TickPipelineContext,
  TickStage,
} from '../types';

function createRequest(): AgentInvocationRequest {
  return {
    query: '继续执行',
    promptKey: 'default',
    model_id: 'mock-model',
    mode: 'agent',
    maxSteps: 8,
    enableTools: false,
    availableTools: [],
  };
}

function createPipelineContext(): TickPipelineContext {
  const request = createRequest();
  return {
    input: {
      request,
      history: [],
      stream: false,
    },
    newEvents: [],
    request,
    history: [],
    forceFinalAnswer: false,
    modelId: '',
    toolSchemas: [],
    llmOptions: {},
    llmMessages: [],
    mode: 'agent',
    conversationId: 'conv_tick_pipeline',
    turnId: 'turn_tick_pipeline',
  };
}

describe('runTickPipeline', () => {
  it('按固定 stage 顺序执行，并对每个 stage 应用 around middleware 包裹顺序', async () => {
    const ctx = createPipelineContext();
    const calls: string[] = [];

    const stages: TickStage[] = [
      {
        id: 'prepare_call',
        async run() {
          calls.push('stage:prepare_call');
        },
      },
      {
        id: 'execute_llm',
        async run() {
          calls.push('stage:execute_llm');
        },
      },
    ];

    const outer: TickAroundMiddleware = async (_ctx, stage, next) => {
      calls.push(`outer:before:${stage.id}`);
      await next();
      calls.push(`outer:after:${stage.id}`);
    };
    const inner: TickAroundMiddleware = async (_ctx, stage, next) => {
      calls.push(`inner:before:${stage.id}`);
      await next();
      calls.push(`inner:after:${stage.id}`);
    };

    await runTickPipeline(ctx, stages, [outer, inner]);

    expect(calls).toEqual([
      'outer:before:prepare_call',
      'inner:before:prepare_call',
      'stage:prepare_call',
      'inner:after:prepare_call',
      'outer:after:prepare_call',
      'outer:before:execute_llm',
      'inner:before:execute_llm',
      'stage:execute_llm',
      'inner:after:execute_llm',
      'outer:after:execute_llm',
    ]);
  });

  it('stage 抛错时应保持原错误传播语义，并停止后续 stage', async () => {
    const ctx = createPipelineContext();
    const calls: string[] = [];
    const error = new Error('execute_llm failed');

    const stages: TickStage[] = [
      {
        id: 'prepare_call',
        async run() {
          calls.push('stage:prepare_call');
        },
      },
      {
        id: 'execute_llm',
        async run() {
          calls.push('stage:execute_llm');
          throw error;
        },
      },
      {
        id: 'build_decision',
        async run() {
          calls.push('stage:build_decision');
        },
      },
    ];

    const middleware: TickAroundMiddleware = async (_ctx, stage, next) => {
      calls.push(`mw:before:${stage.id}`);
      await next();
      calls.push(`mw:after:${stage.id}`);
    };

    await expect(runTickPipeline(ctx, stages, [middleware])).rejects.toThrow(error);
    expect(calls).toEqual([
      'mw:before:prepare_call',
      'stage:prepare_call',
      'mw:after:prepare_call',
      'mw:before:execute_llm',
      'stage:execute_llm',
    ]);
  });
});
