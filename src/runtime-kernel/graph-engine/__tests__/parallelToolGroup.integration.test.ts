import { describe, expect, it, vi } from 'vitest';
import { ToolCallIdSchema, type RoutedRuntimeEvent } from '../../../contracts';
import { GraphExecutor } from '../engine';
import { MemoryCheckpointer } from '../checkpointer/memoryCheckpointer';
import { ToolNode } from '../nodes/toolNode';
import { createRuntimeEventRecorder } from '../../../testkit';
import { RunPauseRequested, type ToolRecoveryPort } from '../definitions/runContinuation';
import type { EngineLocalState, EngineState, StandardToolCall } from '../types';
import type { ToolExecutionResult } from '../../tools/ports';
import type { ToolExecutionContext } from '../../tools/toolExecutionContext';

/**
 * 并行组的行为测试走真实 GraphExecutor + ToolNode + 原子断点提交：
 * 提交端口校验 revision 逐次 +1，并发提交会直接失败；工具用可控 promise 决定何时结束，
 * 证明“同时在跑”靠的是开始/结束先后，而不是计时。
 */

type Handler = (context: ToolExecutionContext) => Promise<ToolExecutionResult>;

const ok = (observation: string): ToolExecutionResult => ({
  success: true, result: JSON.stringify({ data: {}, observation }), durationMs: 1,
});

/** par 声明可并行，ser 没有声明；参数里的 key 就是调用 ID，方便核对上下文身份。 */
const call = (tool: 'par' | 'ser', key: string): StandardToolCall => ({
  id: ToolCallIdSchema.parse(key), type: 'function',
  function: { name: tool, arguments: JSON.stringify({ key }) },
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { open, opened };
}

function fixture(options: { maxParallelToolCalls?: number; abortGraceMs?: number } = {}) {
  const checkpointer = new MemoryCheckpointer();
  const durable: RoutedRuntimeEvent[] = [];
  let staged: RoutedRuntimeEvent[] = [];
  let rejectCommit: ((state: EngineState) => boolean) | undefined;
  const log: string[] = [];
  const started: string[] = [];
  const handlers = new Map<string, Handler>();
  const executions = new Map<string, number>();
  const sink = createRuntimeEventRecorder({ conversationId: 'conversation', runId: 'run' }).sink;

  function capabilities(signal?: AbortSignal): Pick<EngineLocalState, 'runtimeEventSink' | 'toolContext' | 'signal'> {
    return {
      signal,
      toolContext: { conversationId: 'conversation', turnId: 'turn', ...(signal ? { abortSignal: signal } : {}) },
      runtimeEventSink(event, source) {
        const routed = sink(event, source);
        if (routed.type === 'tool_output') staged.push(routed);
        return routed;
      },
    };
  }

  function engine() {
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
      toolRuntime: {
        getToolDefinition: name => ({
          parameters: { type: 'object', properties: { key: { type: 'string' } } },
          ...(name === 'par' ? { parallel: true as const } : {}),
        }),
        async executeTool(_name, args, context) {
          const key = String(args.key);
          executions.set(key, (executions.get(key) ?? 0) + 1);
          started.push(key);
          log.push(`start:${key}`);
          try {
            const result = await (handlers.get(key) ?? (async () => ok(key)))(context);
            log.push(`end:${key}`);
            return result;
          } catch (error) {
            log.push(`throw:${key}`);
            throw error;
          }
        },
      },
      observationPreview: { async truncateObservation({ text }) { return { truncated: false, preview: text }; } },
      ...options,
    }));
    return graph;
  }

  async function checkpoint() {
    const state = await checkpointer.load('run');
    if (!state?.revision) throw new Error('missing checkpoint');
    return state;
  }

  return {
    log, started, durable, handlers, executions, capabilities, engine, checkpoint,
    on(key: string, handler: Handler) { handlers.set(key, handler); },
    start(calls: StandardToolCall[], signal?: AbortSignal) {
      return engine().startSession('run', {
        ...capabilities(signal), conversationId: 'conversation', turnId: 'turn',
        request: { query: 'original' }, history: [],
        executorLocal: { stepCount: 0, maxSteps: 10 },
        pendingToolCalls: calls, toolBatchCompletionMode: 'yield_after_batch',
      }, 'tool');
    },
    outputs() {
      return durable.flatMap(event => (event.type === 'tool_output' ? [[event.tool_call_id, event.status]] : []));
    },
    failCommit(predicate: ((state: EngineState) => boolean) | undefined) { rejectCommit = predicate; },
    /** 进程退出：未提交的事实随之丢失。 */
    crash() { staged = []; },
  };
}

describe('相邻的可并行调用分组并发执行', () => {
  it('两个可并行调用同时在跑：两个都已开始时，还没有一个结束', async () => {
    const f = fixture();
    const g1 = gate();
    const g2 = gate();
    f.on('p1', async () => { await g1.opened; return ok('p1'); });
    f.on('p2', async () => { await g2.opened; return ok('p2'); });
    const run = f.start([call('par', 'p1'), call('par', 'p2')]);
    await vi.waitFor(() => expect(f.started).toEqual(['p1', 'p2']));
    expect(f.log).toEqual(['start:p1', 'start:p2']);
    // 后开始的先结束：结果按完成先后写入，配对不受影响。
    g2.open();
    await vi.waitFor(() => expect(f.outputs()).toEqual([['p2', 'success']]));
    g1.open();
    const result = await run;
    expect(result.checkpoint).toMatchObject({ executionStatus: 'yielded', local: { pendingToolCalls: [] } });
    expect(result.checkpoint.local?.executingToolCallIds).toBeUndefined();
    expect(f.outputs()).toEqual([['p2', 'success'], ['p1', 'success']]);
  });

  it('未声明可并行的调用是屏障：[并行, 并行, 串行, 并行] 分三段按原顺序执行', async () => {
    const f = fixture();
    const g1 = gate();
    const g2 = gate();
    f.on('p1', async () => { await g1.opened; return ok('p1'); });
    f.on('p2', async () => { await g2.opened; return ok('p2'); });
    const run = f.start([call('par', 'p1'), call('par', 'p2'), call('ser', 's3'), call('par', 'p4')]);
    await vi.waitFor(() => expect(f.started).toEqual(['p1', 'p2']));
    g1.open();
    await vi.waitFor(() => expect(f.log).toContain('end:p1'));
    // p1 已结束但 p2 仍在跑：串行调用必须等整组结束。
    expect(f.started).toEqual(['p1', 'p2']);
    g2.open();
    await run;
    expect(f.log).toEqual(['start:p1', 'start:p2', 'end:p1', 'end:p2', 'start:s3', 'end:s3', 'start:p4', 'end:p4']);
    expect(f.outputs().map(([id]) => id)).toEqual(['p1', 'p2', 's3', 'p4']);
  });

  it('同时在跑的不超过上限 3，一个结束补一个；Host 可改上限', async () => {
    const f = fixture();
    const gates = new Map(['p1', 'p2', 'p3', 'p4', 'p5'].map(key => [key, gate()]));
    for (const [key, g] of gates) f.on(key, async () => { await g.opened; return ok(key); });
    const run = f.start(['p1', 'p2', 'p3', 'p4', 'p5'].map(key => call('par', key)));
    await vi.waitFor(() => expect(f.started).toEqual(['p1', 'p2', 'p3']));
    gates.get('p2')?.open();
    await vi.waitFor(() => expect(f.started).toEqual(['p1', 'p2', 'p3', 'p4']));
    expect(f.log.filter(entry => entry.startsWith('end:'))).toEqual(['end:p2']);
    for (const g of gates.values()) g.open();
    await run;
    expect(f.outputs()).toHaveLength(5);

    const single = fixture({ maxParallelToolCalls: 1 });
    const hold = gate();
    single.on('p1', async () => { await hold.opened; return ok('p1'); });
    const serialRun = single.start([call('par', 'p1'), call('par', 'p2')]);
    await vi.waitFor(() => expect(single.started).toEqual(['p1']));
    hold.open();
    await serialRun;
    expect(single.log).toEqual(['start:p1', 'end:p1', 'start:p2', 'end:p2']);
    expect(() => fixture({ maxParallelToolCalls: 0 }).engine()).toThrow('maxParallelToolCalls');
  });

  it('组内一个调用失败不影响同伴：各自返回结果，运行继续', async () => {
    const f = fixture();
    const hold = gate();
    f.on('p1', async () => ({ success: false, error: 'source unavailable', errorKind: 'execution', durationMs: 1 }));
    f.on('p2', async () => { await hold.opened; return ok('p2'); });
    const run = f.start([call('par', 'p1'), call('par', 'p2'), call('ser', 's3')]);
    await vi.waitFor(() => expect(f.outputs()).toEqual([['p1', 'error']]));
    hold.open();
    const result = await run;
    expect(f.outputs()).toEqual([['p1', 'error'], ['p2', 'success'], ['s3', 'success']]);
    expect(result.checkpoint).toMatchObject({ executionStatus: 'yielded' });
  });

  it('组内调用抛出异常时：同伴照常结束并提交，之后才上报异常，未启动的调用不再启动', async () => {
    const f = fixture({ maxParallelToolCalls: 2 });
    const hold = gate();
    f.on('p1', async () => { throw new Error('host port crashed'); });
    f.on('p2', async () => { await hold.opened; return ok('p2'); });
    const run = f.start([call('par', 'p1'), call('par', 'p2'), call('par', 'p3')]);
    await vi.waitFor(() => expect(f.log).toContain('throw:p1'));
    hold.open();
    await expect(run).rejects.toThrow('host port crashed');
    expect(f.started).toEqual(['p1', 'p2']);
    expect(f.outputs()).toEqual([['p2', 'success']]);
    const state = await f.checkpoint();
    expect(state.local?.pendingToolCalls?.map(item => item.id)).toEqual(['p1', 'p3']);
    // p1 的副作用结果未知：意图保留，继续前必须对账。
    expect(state.local?.executingToolCallIds).toEqual(['p1']);
  });

  it('并发时每个调用拿到自己的父工具调用身份，执行全程不被同伴改写', async () => {
    const f = fixture();
    const seen: Array<[string, string | undefined, string | undefined]> = [];
    const hold = gate();
    for (const key of ['p1', 'p2', 'p3']) {
      f.on(key, async context => {
        const atStart = context.parentToolCallId;
        await hold.opened;
        seen.push([key, atStart, context.parentToolCallId]);
        return ok(key);
      });
    }
    const run = f.start(['p1', 'p2', 'p3'].map(key => call('par', key)));
    await vi.waitFor(() => expect(f.started).toHaveLength(3));
    hold.open();
    await run;
    expect(seen.sort()).toEqual([['p1', 'p1', 'p1'], ['p2', 'p2', 'p2'], ['p3', 'p3', 'p3']]);
  });

  it('可并行工具返回等待用户等控制时按结果合同错误结算，同伴不受影响', async () => {
    const f = fixture();
    f.on('p1', async () => ({
      success: true, durationMs: 1,
      result: JSON.stringify({ data: {}, observation: 'ask', control: { requireUser: true } }),
    }));
    const result = await f.start([call('par', 'p1'), call('par', 'p2')]);
    expect(f.outputs()).toEqual([['p1', 'error'], ['p2', 'success']]);
    expect(result.checkpoint.nodeId).not.toBe('wait_user');
    const p1 = f.durable.find(event => event.type === 'tool_output' && event.tool_call_id === 'p1');
    expect(p1?.type === 'tool_output' && p1.status === 'error' ? p1.error : '').toContain('TOOL_RESULT_CONTRACT_VIOLATION');
  });
});

describe('并行组的取消与续跑', () => {
  it('取消传到组内所有在跑的调用；在跑的、未启动的和后续调用都结算为已取消', async () => {
    const f = fixture({ maxParallelToolCalls: 2 });
    const controller = new AbortController();
    const aborted: string[] = [];
    for (const key of ['p1', 'p2']) {
      f.on(key, context => new Promise((_resolve, reject) => {
        context.abortSignal?.addEventListener('abort', () => {
          aborted.push(key);
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true });
      }));
    }
    const run = f.start([call('par', 'p1'), call('par', 'p2'), call('par', 'p3'), call('ser', 's4')], controller.signal);
    await vi.waitFor(() => expect(f.started).toEqual(['p1', 'p2']));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted.sort()).toEqual(['p1', 'p2']);
    expect(f.started).toEqual(['p1', 'p2']);
    expect(f.outputs().map(([id, status]) => `${id}:${status}`).sort())
      .toEqual(['p1:error', 'p2:error', 'p3:error', 's4:error']);
    const state = await f.checkpoint();
    expect(state).toMatchObject({ executionStatus: 'yielded', local: { pendingToolCalls: [] } });
    expect(state.local?.executingToolCallIds).toBeUndefined();
  });

  it('暂停时已完成的调用照常提交；继续后只对账并补跑未完成的调用', async () => {
    const f = fixture({ abortGraceMs: 20 });
    const controller = new AbortController();
    const stuck = gate();
    f.on('p2', async () => { await stuck.opened; return ok('late'); });
    f.on('p1', async () => ok('p1'));
    const run = f.start([call('par', 'p1'), call('par', 'p2'), call('ser', 's3')], controller.signal);
    await vi.waitFor(() => expect(f.outputs()).toEqual([['p1', 'success']]));
    controller.abort(new RunPauseRequested());
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const paused = await f.checkpoint();
    expect(paused.local?.pendingToolCalls?.map(item => item.id)).toEqual(['p2', 's3']);
    expect(paused.local?.executingToolCallIds).toEqual(['p2']);
    stuck.open();

    const reconciled: string[] = [];
    const toolRecoveryPort: ToolRecoveryPort = {
      async reconcile(original) { reconciled.push(original.id); return { kind: 'retry' }; },
    };
    f.on('p2', async () => ok('p2'));
    const result = await f.engine().continueSession('run', {
      expectedRevision: paused.revision ?? 0,
      capabilities: { ...f.capabilities(new AbortController().signal), toolRecoveryPort },
    });
    expect(reconciled).toEqual(['p2']);
    expect(Object.fromEntries(f.executions)).toEqual({ p1: 1, p2: 2, s3: 1 });
    expect(f.outputs()).toEqual([['p1', 'success'], ['p2', 'success'], ['s3', 'success']]);
    expect(result.checkpoint.local?.executingToolCallIds).toBeUndefined();
  });

  it('崩溃时结果尚未提交的调用在继续时由 owner 对账，已提交的同伴不重跑', async () => {
    const f = fixture();
    const g2 = gate();
    f.on('p2', async () => { await g2.opened; return ok('p2'); });
    const run = f.start([call('par', 'p1'), call('par', 'p2')]);
    await vi.waitFor(() => expect(f.outputs()).toEqual([['p1', 'success']]));
    // p2 已完成副作用，但写结果的那次提交失败（相当于进程在提交前退出）。
    f.failCommit(state => !state.local?.pendingToolCalls?.some(item => item.id === 'p2'));
    g2.open();
    await expect(run).rejects.toThrow('commit failed');
    f.crash();
    f.failCommit(undefined);
    const crashed = await f.checkpoint();
    expect(crashed.local?.pendingToolCalls?.map(item => item.id)).toEqual(['p2']);
    expect(crashed.local?.executingToolCallIds).toEqual(['p2']);

    const toolRecoveryPort: ToolRecoveryPort = {
      async reconcile(original) {
        expect(original.id).toBe('p2');
        return { kind: 'settled', result: ok('p2 from owner record') };
      },
    };
    await f.engine().continueSession('run', {
      expectedRevision: crashed.revision ?? 0,
      capabilities: { ...f.capabilities(), toolRecoveryPort },
    });
    expect(Object.fromEntries(f.executions)).toEqual({ p1: 1, p2: 1 });
    expect(f.outputs()).toEqual([['p1', 'success'], ['p2', 'success']]);
  });
});
