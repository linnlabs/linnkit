import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeEvent, runtimeEventToSSEEvent, validateSSEEvent } from '../../../contracts';
import type { CanonicalInferenceEvent, CanonicalInferencePort, CanonicalInferenceRequest } from '../../../ports';
import { agentEventToRuntime } from '../../events/agent-to-runtime';
import type { AnyAgentEvent } from '../../events/agentEvents';
import { EventBus, EventSequencer, RuntimeEventPublisher, EventBusEventPersistence } from '../../execution';
import { MemoryEventStore } from '../../graph-engine/event-store/memoryEventStore';
import { projectChildRuntimeEventToSubRunTrace } from '../../child-run-trace/projectChildRuntimeEventToSubRunTrace';
import { RuntimeEventSubRunTracePublisher } from '../../child-run-trace/runtimeEventSubRunTracePublisher';
import { describeRuntimeEventLifecycle } from '../../events/eventGovernance';
import { LlmCaller, type LlmCallerOptions } from '../caller';
import type { ModelCatalogLike } from '../modelCatalog';

const model = { id: 'test', enabled: true, capabilities: ['chat'], billing_mode: 'byok' as const,
  adapter_input_support: { user_image: false, tool_result_image: false } };
const catalog: ModelCatalogLike = {
  getModelById: () => model, getModelsByCapability: () => [model], getModelsByUIVisibility: () => [model],
};
type Outcome = 'transport' | 'empty' | 'arguments' | 'success' | 'auth' | 'rate_limit' | 'provider-output';
function fixture(outcomes: Outcome[], options: Partial<LlmCallerOptions> = {}) {
  const requests: CanonicalInferenceRequest[] = [];
  const events: AnyAgentEvent[] = [];
  const inferencePort: CanonicalInferencePort = {
    async *stream(request): AsyncIterable<CanonicalInferenceEvent> {
      requests.push(request);
      yield { type: 'start', model_id: request.model_id, attempt_id: request.invocation.attempt_id };
      const next = outcomes.shift();
      if (next === 'success') {
        yield { type: 'answer_delta', text: 'complete' };
        yield { type: 'finish', reason: 'stop' };
      } else if (next === 'empty') {
        yield { type: 'finish', reason: 'stop' };
      } else if (next === 'arguments') {
        throw new Error('invalid tool_call.arguments');
      } else if (next === 'rate_limit' || next === 'provider-output') {
        yield { type: 'failure', kind: 'provider', code: 'host_defined_failure', retryable: true, retry_category: next === 'rate_limit' ? 'rate_limit' : 'output' };
      } else if (next === 'auth') {
        yield { type: 'failure', kind: 'provider', code: 'auth_failed', retryable: false };
      } else if (next === 'transport') {
        yield { type: 'answer_delta', text: 'partial' };
        yield { type: 'failure', kind: 'transport', code: 'connection_reset', retryable: true };
      } else throw new Error('missing scripted attempt');
    },
  };
  const caller = new LlmCaller({ inferencePort, modelCatalog: catalog, maxRetries: 6,
    maxRetriesByCategory: { output: 3, rate_limit: 3, other: 3 }, retryDelayMs: 1500, ...options });
  return { caller, requests, events,
    call: (signal?: AbortSignal) => caller.callWithRetries('test', [{ role: 'user', content: 'hello' }], {}, e => events.push(e), signal),
    retries: () => events.filter(e => e.type === 'llm_retry'),
  };
}

describe('category retry budget and durable retry lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('六次网络重试按 1.5/3/6/12/24/48 秒等待，共七次真实调用并收口', async () => {
    const f = fixture(Array.from({ length: 7 }, () => 'transport'));
    const result = f.call().catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    for (const [i, delay] of [1500, 3000, 6000, 12000, 24000, 48000].entries()) {
      expect(f.requests).toHaveLength(i + 1);
      expect(f.retries().at(-1)).toMatchObject({ status: 'waiting', attempt: i + 1, max_retries: 6, delay_ms: delay });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.requests).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await result).toBeInstanceOf(Error);
    expect(f.requests).toHaveLength(7);
    expect(f.retries().at(-1)).toMatchObject({ status: 'exhausted', attempt: 6, total_attempts: 7, started_at: 100_000, timestamp: 194_500 });
    const finalError = f.events.findLast(e => e.type === 'error');
    expect(finalError?.retry_id).toBe(f.retries()[0]?.retry_id);
    expect(f.events.filter(e => e.type === 'error')).toHaveLength(1);
    expect(f.events.filter(e => e.type === 'stream_reset')).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['empty', 'arguments'] as const)('付费输出损坏 %s 只重试三次，等待不指数膨胀', async kind => {
    const f = fixture([kind, kind, kind, kind]);
    const result = f.call().catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect(f.requests).toHaveLength(4);
    expect(f.retries().filter(e => e.status === 'waiting').map(e => e.delay_ms)).toEqual([1500, 1500, 1500]);
    expect(f.retries().at(-1)).toMatchObject({ status: 'exhausted', category: 'output', attempt: 3, max_retries: 3 });
  });

  it.each([
    { kind: 'rate_limit' as const, category: 'rate_limit', delays: [1500, 3000, 6000] },
    { kind: 'provider-output' as const, category: 'output', delays: [1500, 1500, 1500] },
  ])('canonical显式分类 $category 决定配额和等待，不猜供应商code', async ({ kind, category, delays }) => {
    const f = fixture([kind, kind, kind, kind]);
    const result = f.call().catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect(f.requests).toHaveLength(4);
    expect(f.retries().filter(e => e.status === 'waiting').map(e => e.delay_ms)).toEqual(delays);
    expect(f.retries().at(-1)).toMatchObject({ category, status: 'exhausted', attempt: 3, max_retries: 3, error_code: 'llm.host_defined_failure' });
  });

  it('混合错误分别计类别，但不能突破同模型总六次；显式总调用预算同样约束', async () => {
    for (const maxTotalAttempts of [8, 3]) {
      const f = fixture(['transport', 'empty', 'transport', 'empty', 'transport', 'empty', 'transport'], { maxTotalAttempts });
      const result = f.call().catch(error => error);
      await vi.runAllTimersAsync();
      expect(await result).toBeInstanceOf(Error);
      expect(f.requests).toHaveLength(maxTotalAttempts === 8 ? 7 : 3);
      expect(f.retries().at(-1)?.status).toBe('exhausted');
      expect(f.retries().filter(e => e.status === 'waiting' && e.category === 'output')).toHaveLength(maxTotalAttempts === 8 ? 3 : 1);
    }
  });

  it('长退避最多 60 秒，并保留明确的更长供应商等待', async () => {
    const f = fixture(Array.from({ length: 9 }, () => 'transport'), { maxRetries: 8, maxRetriesByCategory: { output: 3 } });
    const result = f.call().catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect(f.retries().filter(e => e.status === 'waiting').map(e => e.delay_ms)).toEqual([1500, 3000, 6000, 12000, 24000, 48000, 60000, 60000]);
  });

  it('等待中取消立即清掉 timer，仅收口取消事实；新调用使用新 episode', async () => {
    const f = fixture(['transport', 'transport', 'success']);
    const controller = new AbortController();
    const first = f.call(controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(400);
    controller.abort('user_cancelled');
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(f.requests).toHaveLength(1);
    expect(f.retries().at(-1)).toMatchObject({ status: 'cancelled', timestamp: 100_400 });
    expect(f.events.filter(e => e.type === 'error')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    const firstId = f.retries()[0]?.retry_id;
    const second = f.call();
    await vi.runAllTimersAsync();
    await expect(second).resolves.toEqual({ content: 'complete' });
    expect(f.retries().at(-1)).toMatchObject({ status: 'succeeded', attempt: 1, total_attempts: 2 });
    expect(f.retries().at(-1)?.retry_id).not.toBe(firstId);
  });

  it('最终不可重试错误保持实际错误码，不再循环；成功后的部分输出撤回', async () => {
    const f = fixture(['transport', 'auth']);
    const result = f.call().catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ errorCode: 'llm.auth_failed' });
    expect(f.requests).toHaveLength(2);
    expect(f.retries().at(-1)).toMatchObject({ status: 'failed', error_code: 'llm.auth_failed' });
  });

  it('同一事实经过 Agent→Runtime→JSON重放→SSE，durable而不进入模型上下文', async () => {
    const f = fixture(['transport', 'success']);
    const result = f.call();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ content: 'complete' });
    expect(f.retries().map(e => e.status)).toEqual(['waiting', 'retrying', 'succeeded']);
    for (const e of f.retries()) {
      const mapped = agentEventToRuntime(e, { conversationId: 'conv-1', turnId: 'turn-1' });
      const persisted = RuntimeEvent.parse(JSON.parse(JSON.stringify({ ...mapped, run_id: 'run-1', lane: 'foreground', visibility: 'conversation' })));
      const wire = runtimeEventToSSEEvent(persisted);
      expect(validateSSEEvent(wire).success).toBe(true);
      expect(wire).toMatchObject({ type: 'llm_retry', retry_id: e.retry_id, status: e.status, started_at: 100_000 });
      expect(describeRuntimeEventLifecycle(persisted)).toMatchObject({ persist: true, replayToUi: true, enterAgentContext: false, realtimeChannel: 'event_bus_sse' });
      expect(e.error).toBe('Network connection interrupted');
    }
  });

  it('关闭客户端重试和认证错误不产生伪造重试 episode', async () => {
    for (const options of [{ maxRetries: 0, maxRetriesByCategory: undefined }, { modelCatalog: { ...catalog, getModelById: () => ({ ...model, billing_mode: 'cloud' as const }) } }]) {
      const f = fixture(['transport'], options);
      await expect(f.call()).rejects.toBeInstanceOf(Error);
      expect(f.requests).toHaveLength(1);
      expect(f.retries()).toEqual([]);
    }
  });
  it('等待与取消事实在断点提交前可重放；child trace保持同一来源且不串主正文', async () => {
    const sequencer = new EventSequencer('conv-1');
    const bus = new EventBus(sequencer.getExecutionId());
    const publisher = new RuntimeEventPublisher(bus, sequencer, { run_id: 'run-child', parent_run_id: 'run-parent', lane: 'child', visibility: 'parent-trace' });
    const store = new MemoryEventStore();
    const writer = vi.fn(async () => undefined);
    let cursor = 0;
    const persistence = new EventBusEventPersistence({ eventBus: bus, eventStore: store,
      nextEventStoreId: () => `cursor-${++cursor}`, checkpointWriter: writer });
    persistence.connect();
    const parentSequencer = new EventSequencer('conv-1');
    const parentBus = new EventBus(parentSequencer.getExecutionId());
    const parentPublisher = new RuntimeEventPublisher(parentBus, parentSequencer, { run_id: 'run-parent', lane: 'foreground', visibility: 'conversation' });
    const traces: RuntimeEvent[] = [];
    const tracePublisher = new RuntimeEventSubRunTracePublisher({
      conversationId: 'conv-1', turnId: 'turn-1', parentToolCallId: 'call-child', subrunId: 'run-child',
      runtimeEventSink: (event, source) => {
        const routed = parentPublisher.publish(event, source);
        traces.push(routed);
        return routed;
      },
    });
    const events: RuntimeEvent[] = [];
    bus.on('event', envelope => {
      events.push(envelope.payload);
      const trace = projectChildRuntimeEventToSubRunTrace(envelope.payload);
      if (trace) tracePublisher.publish(trace);
    });
    const f = fixture(['transport']);
    const controller = new AbortController();
    const result = f.caller.callWithRetries('test', [{ role: 'user', content: 'hello' }], {}, e => {
      const draft = agentEventToRuntime(e, { conversationId: 'conv-1', turnId: 'turn-1' });
      if (draft) publisher.publish(draft, 'test');
    }, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await persistence.drain();
    const waiting = (await store.range('conv-1')).map(row => row.event);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ type: 'llm_retry', status: 'waiting' });
    expect(writer).not.toHaveBeenCalled();
    const waitingEvent = events.find(e => e.type === 'llm_retry');
    if (!waitingEvent) throw new Error('missing retry event');
    publisher.publish(waitingEvent, 'duplicate-delivery');
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    await persistence.drain();
    persistence.finishCheckpointWrites();
    const rows = await store.range('conv-1');
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.event.type === 'llm_retry' ? row.event.status : row.event.type)).toEqual(['waiting', 'cancelled']);
    expect(new Set(rows.map(row => row.event.id)).size).toBe(2);
    expect(rows.map(row => row.eventStoreId)).toEqual(['cursor-1', 'cursor-2']);
    for (const row of rows) {
      expect(describeRuntimeEventLifecycle(row.event)).toMatchObject({ persist: true, replayToUi: false, enterAgentContext: false });
      const corresponding = traces.find(t => t.type === 'subrun_trace' && t.source_event_id === row.event.id);
      expect(corresponding).toMatchObject({ type: 'subrun_trace', kind: 'llm_retry', ephemeral: true });
      if (!corresponding) throw new Error('missing trace');
      expect(validateSSEEvent(runtimeEventToSSEEvent(corresponding)).success).toBe(true);
    }
    const failure = publisher.publish({ type: 'error', id: 'final-error', conversation_id: 'conv-1', turn_id: 'turn-1', timestamp: Date.now(), version: 1, error: 'Safe failure', error_code: 'llm.auth_failed', retry_id: waitingEvent.type === 'llm_retry' ? waitingEvent.retry_id : undefined, details: { private_diagnostic: 'not for parent' } }, 'test');
    const projected = projectChildRuntimeEventToSubRunTrace(failure);
    expect(projected).toMatchObject({ kind: 'error', source_event_id: failure.id, failure: { error: 'Safe failure', error_code: 'llm.auth_failed' } });
    if (projected?.kind !== 'error') throw new Error('missing error trace');
    expect(projected.failure).not.toHaveProperty('details');
    tracePublisher.publish(projected);
    expect(validateSSEEvent(runtimeEventToSSEEvent(traces.at(-1)!)).success).toBe(true);
    await persistence.drain();
  });

});
