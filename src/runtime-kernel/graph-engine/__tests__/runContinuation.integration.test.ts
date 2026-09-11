import { describe, expect, it, vi } from 'vitest';
import { ToolCallIdSchema, type RoutedRuntimeEvent } from '../../../contracts';
import { GraphExecutor } from '../engine';
import { MemoryCheckpointer } from '../checkpointer/memoryCheckpointer';
import { ToolNode } from '../nodes/toolNode';
import { createRuntimeEventAdmissionSink } from '../nodes/__tests__/runtimeEventAdmissionFixture';
import { RunPauseRequested, type ToolRecoveryPort } from '../definitions/runContinuation';
import type { EngineLocalState, EngineState } from '../types';
import type { ToolExecutionPort, ToolExecutionResult } from '../../tools/ports';

const success: ToolExecutionResult = { success: true, result: { data: { saved: true }, observation: 'saved' }, durationMs: 1 };
const call = (id: string) => ({ id: ToolCallIdSchema.parse(id), type: 'function' as const,
  function: { name: 'write', arguments: '{}' } });

function fixture() {
  const checkpointer = new MemoryCheckpointer();
  const durable: RoutedRuntimeEvent[] = [];
  let staged: RoutedRuntimeEvent[] = [];
  let rejectCommit: ((state: EngineState) => boolean) | undefined;
  const sink = createRuntimeEventAdmissionSink('conversation', 'run');
  const capabilities: Pick<EngineLocalState, 'runtimeEventSink' | 'toolContext'> = {
    toolContext: { conversationId: 'conversation', turnId: 'turn' },
    runtimeEventSink(event, source) {
      const routed = sink(event, source);
      if (routed.type === 'tool_output') staged.push(routed);
      return routed;
    },
  };
  function engine(executeTool: ToolExecutionPort['executeTool']) {
    const graph = new GraphExecutor(checkpointer, {
      maxSteps: 10,
      executionCheckpointPort: {
        async commit(key, state) {
          if (rejectCommit?.(state)) throw new Error('commit failed');
          const prior = await checkpointer.load(key);
          expect(state.revision).toBe((prior?.revision ?? 0) + 1);
          await checkpointer.save(key, state);
          durable.push(...staged);
          staged = [];
        },
      },
    });
    graph.registerNode(new ToolNode({
      toolRuntime: { getToolDefinition: () => ({ parameters: { type: 'object', properties: {} } }), executeTool },
      observationPreview: { async truncateObservation() { return { truncated: false, preview: 'saved' }; } },
    }));
    return graph;
  }
  async function checkpoint() {
    const state = await checkpointer.load('run');
    if (!state?.revision) throw new Error('missing checkpoint');
    return { state, revision: state.revision };
  }
  return { checkpointer, durable, capabilities, engine, checkpoint,
    start: (graph: GraphExecutor, signal?: AbortSignal) => graph.startSession('run', {
      ...capabilities, signal, conversationId: 'conversation', turnId: 'turn',
      request: { query: 'original', promptKey: 'agent' }, history: [],
      executorLocal: { stepCount: 0, maxSteps: 10, runLockedModelId: 'original-model' },
      pendingToolCalls: [call('call-1'), call('call-2')], toolBatchCompletionMode: 'yield_after_batch',
    }, 'tool'),
    crash() { staged = []; },
    failCommit(predicate: (state: EngineState) => boolean) { rejectCommit = predicate; },
  };
}

describe('durable graph continuation', () => {
  it('暂停不结算尚未执行工具；新引擎接续原 call、请求、模型与累计预算', async () => {
    const f = fixture();
    const controller = new AbortController();
    const execute = vi.fn(async () => { controller.abort(new RunPauseRequested()); return success; });
    await expect(f.start(f.engine(execute), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledOnce();
    expect(f.durable.map(event => event.type === 'tool_output' && event.tool_call_id)).toEqual(['call-1']);
    const { state, revision } = await f.checkpoint();
    expect(state.local?.pendingToolCalls?.map(tool => tool.id)).toEqual(['call-2']);
    expect(state.local?.executingToolCallId).toBeUndefined();
    const nextExecute = vi.fn(async () => success);
    const result = await f.engine(nextExecute).continueSession('run', {
      expectedRevision: revision, capabilities: { ...f.capabilities, signal: new AbortController().signal },
    });
    expect(nextExecute).toHaveBeenCalledOnce();
    expect(result.checkpoint).toMatchObject({ executionStatus: 'yielded', local: {
      request: { query: 'original', promptKey: 'agent' },
      executorLocal: { stepCount: 2, maxSteps: 10, runLockedModelId: 'original-model' },
    } });
    expect(f.durable).toHaveLength(2);
  });

  it('owner 已完成而 checkpoint 未提交时，先阻塞；对账后不重复执行副作用', async () => {
    const f = fixture();
    let effects = 0;
    f.failCommit(state => effects === 1 && !state.local?.executingToolCallId);
    await expect(f.start(f.engine(async () => { effects += 1; return success; }))).rejects.toThrow('commit failed');
    f.crash();
    expect(f.durable).toEqual([]);
    expect((await f.checkpoint()).state.local?.executingToolCallId).toBe('call-1');
    f.failCommit(() => false);
    const execute = vi.fn(async () => { effects += 1; return success; });
    await expect(f.engine(execute).continueSession('run', {
      expectedRevision: (await f.checkpoint()).revision, capabilities: f.capabilities,
    })).rejects.toThrow('Tool outcome is unknown');
    expect(execute).not.toHaveBeenCalled();
    const toolRecoveryPort: ToolRecoveryPort = { async reconcile(originalCall) {
      expect(originalCall.id).toBe('call-1');
      return { kind: 'settled', result: success };
    } };
    await f.engine(execute).continueSession('run', {
      expectedRevision: (await f.checkpoint()).revision,
      capabilities: { ...f.capabilities, toolRecoveryPort },
    });
    expect(effects).toBe(2);
    expect(f.durable.map(event => event.type === 'tool_output' && event.tool_call_id)).toEqual(['call-1', 'call-2']);
  });

  it('执行意图提交失败则零副作用；yielded 断点不会重复最终工具', async () => {
    const f = fixture();
    const execute = vi.fn(async () => success);
    f.failCommit(state => state.local?.executingToolCallId === 'call-1');
    await expect(f.start(f.engine(execute))).rejects.toThrow('commit failed');
    expect(execute).not.toHaveBeenCalled();
    f.failCommit(() => false);
    await f.engine(execute).continueSession('run', {
      expectedRevision: (await f.checkpoint()).revision, capabilities: f.capabilities,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    const result = await f.engine(execute).continueSession('run', {
      expectedRevision: (await f.checkpoint()).revision, capabilities: f.capabilities,
    });
    expect(result.stepCount).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('两个继续入口只能执行一次，旧 revision 被拒绝', async () => {
    const f = fixture();
    f.failCommit(state => state.local?.executingToolCallId === 'call-1');
    await expect(f.start(f.engine(async () => success))).rejects.toThrow();
    f.failCommit(() => false);
    const execute = vi.fn(async () => success);
    const engine = f.engine(execute);
    const input = { expectedRevision: (await f.checkpoint()).revision, capabilities: f.capabilities };
    const results = await Promise.allSettled([engine.continueSession('run', input), engine.continueSession('run', input)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
