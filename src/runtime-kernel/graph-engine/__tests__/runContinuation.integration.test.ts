import { describe, expect, it, vi } from 'vitest';
import { createThoughtEvent, ToolCallIdSchema, type RoutedRuntimeEvent } from '../../../contracts';
import { GraphExecutor } from '../engine';
import { MemoryCheckpointer } from '../checkpointer/memoryCheckpointer';
import { ToolNode } from '../nodes/toolNode';
import { createRuntimeEventRecorder } from '../../../testkit';
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
  const sink = createRuntimeEventRecorder({ conversationId: 'conversation', runId: 'run' }).sink;
  const capabilities: Pick<EngineLocalState, 'runtimeEventSink' | 'toolContext'> = {
    toolContext: { conversationId: 'conversation', turnId: 'turn' },
    runtimeEventSink(event, source) {
      const routed = sink(event, source);
      if (routed.type === 'tool_output') staged.push(routed);
      return routed;
    },
  };
  function engine(executeTool: ToolExecutionPort['executeTool'], options: { abortGraceMs?: number } = {}) {
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
      ...options,
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
      executorLocal: { stepCount: 0, maxSteps: 10 },
      pendingToolCalls: [call('call-1'), call('call-2')], toolBatchCompletionMode: 'yield_after_batch',
    }, 'tool'),
    crash() { staged = []; },
    failCommit(predicate: (state: EngineState) => boolean) { rejectCommit = predicate; },
  };
}

describe('durable graph continuation', () => {
  it('取消旧历史中的流式进度时保留完整事实和每个待执行工具的终态', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => success);
    const complete = createThoughtEvent('complete', 'conversation', 'turn', 'Completed reasoning');
    const progress = createThoughtEvent('progress', 'conversation', 'turn', 'Partial reasoning', {
      ephemeral: true, is_complete: false,
    });
    await expect(f.engine(execute).startSession('run', {
      ...f.capabilities, signal: controller.signal,
      conversationId: 'conversation', turnId: 'turn', history: [complete, progress],
      pendingToolCalls: [call('call-1'), call('call-2')],
    }, 'tool')).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect((await f.checkpoint()).state.local?.history).toEqual([complete, ...f.durable]);
    expect(f.durable.map(event => event.type === 'tool_output' && event.tool_call_id))
      .toEqual(['call-1', 'call-2']);
  });

  it('LLM 决策完成与下一节点之间取消时，结算已接纳的调用而不启动工具', async () => {
    const f = fixture();
    const controller = new AbortController();
    const execute = vi.fn(async () => success);
    const engine = f.engine(execute);
    engine.registerNode({ id: 'llm', async run(state) {
      state.local = { ...state.local, pendingToolCalls: [call('call-1'), call('call-2')] };
      controller.abort();
      return { kind: 'route', nextNodeId: 'tool', events: [] };
    } });
    await expect(engine.startSession('run', { ...f.capabilities,
      signal: controller.signal, conversationId: 'conversation', turnId: 'turn',
      request: { query: 'original', promptKey: 'agent' }, history: [],
      executorLocal: { stepCount: 0, maxSteps: 10 },
    }, 'llm')).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
    expect(f.durable.map(event => event.type === 'tool_output' && event.tool_call_id)).toEqual(['call-1', 'call-2']);
    expect((await f.checkpoint()).state).toMatchObject({ executionStatus: 'yielded', local: { pendingToolCalls: [] } });
  });

  it.each(['aborted', 'committed', 'not-started'] as const)(
    '取消 %s 工具时提交配对终态；不能遗留 staged 事实或重跑动作', async outcome => {
      const f = fixture();
      const controller = new AbortController();
      const execute = vi.fn(async () => {
        controller.abort();
        if (outcome === 'aborted') throw new DOMException('cancelled', 'AbortError');
        return success;
      });
      if (outcome === 'not-started') controller.abort();
      await expect(f.start(f.engine(execute), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(execute).toHaveBeenCalledTimes(outcome === 'not-started' ? 0 : 1);
      expect(f.durable.map(event => event.type === 'tool_output' && [event.tool_call_id, event.status]))
        .toEqual([['call-1', outcome === 'committed' ? 'success' : 'error'], ['call-2', 'error']]);
      expect((await f.checkpoint()).state).toMatchObject({ executionStatus: 'yielded', local: { pendingToolCalls: [] } });
      expect((await f.checkpoint()).state.local?.executingToolCallId).toBeUndefined();
      f.crash();
      await f.engine(execute).continueSession('run', {
        expectedRevision: (await f.checkpoint()).revision, capabilities: f.capabilities,
      });
      expect(execute).toHaveBeenCalledTimes(outcome === 'not-started' ? 0 : 1);
    },
  );

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
      executorLocal: { stepCount: 2, maxSteps: 10 },
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
    expect(result.checkpoint.local?.executorLocal?.stepCount).toBeGreaterThan(0);
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

describe('停止期限：工具不理会停止信号', () => {
  /** 一直不结束、也不理会 abort 的工具；release 后才返回。 */
  function stuckTool() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const execute = vi.fn(async () => { started(); await gate; return success; });
    return { execute, running, release };
  }

  it('暂停后超过期限就停下：当前调用留待对账，迟到的结果不写入', async () => {
    const f = fixture();
    const controller = new AbortController();
    const tool = stuckTool();
    const outcome = f.start(f.engine(tool.execute, { abortGraceMs: 20 }), controller.signal);
    await tool.running;
    const pausedAt = Date.now();
    controller.abort(new RunPauseRequested());
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - pausedAt).toBeLessThan(1_000);
    const { state } = await f.checkpoint();
    // 与工具自己响应停止、结果未知时相同：继续前先对账。
    expect(state.local?.executingToolCallId).toBe('call-1');
    expect(state.local?.pendingToolCalls?.map(tool => tool.id)).toEqual(['call-1', 'call-2']);
    tool.release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.durable).toEqual([]);
  });

  it('取消后超过期限就停下：当前与未开始的调用都结算为已取消', async () => {
    const f = fixture();
    const controller = new AbortController();
    const tool = stuckTool();
    const outcome = f.start(f.engine(tool.execute, { abortGraceMs: 20 }), controller.signal);
    await tool.running;
    controller.abort();
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.durable.map(event => event.type === 'tool_output' && [event.tool_call_id, event.status]))
      .toEqual([['call-1', 'error'], ['call-2', 'error']]);
    tool.release();
  });

  it('期限内自己结束的工具保留真实结果', async () => {
    const f = fixture();
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort(new RunPauseRequested());
      await new Promise(resolve => setTimeout(resolve, 5));
      return success;
    });
    await expect(f.start(f.engine(execute, { abortGraceMs: 200 }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.durable.map(event => event.type === 'tool_output' && event.tool_call_id)).toEqual(['call-1']);
  });

  it('没有停止信号时不限制工具运行时长', async () => {
    const f = fixture();
    const execute = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return success;
    });
    const result = await f.start(f.engine(execute, { abortGraceMs: 5 }), new AbortController().signal);
    expect(result.checkpoint).toMatchObject({ executionStatus: 'yielded' });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
