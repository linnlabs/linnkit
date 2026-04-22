import { describe, expect, it } from 'vitest';

describe('src/agent/runtime-kernel public exports snapshot', () => {
  it('exposes the documented runtime-kernel namespaces', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest).sort()).toMatchSnapshot();
  });

  it('keeps internal-only helpers out of the runtime-kernel root', async () => {
    const moduleUnderTest = await import('../index');
    const symbols = Object.keys(moduleUnderTest);

    expect(symbols).not.toContain('tickPipeline');
    expect(symbols).not.toContain('LlmNodeState');
    expect(symbols).not.toContain('LlmNodeEventBridge');
    expect(symbols).not.toContain('toolIdempotency');
    // 注：MemoryCheckpointer / MemoryEventStore 是 testkit-grade 的 in-memory 实现，
    // 既在 `graph` namespace 暴露（用于消费侧测试 setup），也通过扁平 re-export
    // 出现在 runtime-kernel root；这是公开 surface 的 sugar，非内部 helper。
  });

  it('snapshots the graph namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.graph).sort()).toMatchSnapshot();
  });

  it('snapshots the tools namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.tools).sort()).toMatchSnapshot();
  });

  it('snapshots the execution namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.execution).sort()).toMatchSnapshot();
  });

  it('snapshots the events namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.events).sort()).toMatchSnapshot();
  });

  it('snapshots the runContext namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.runContext).sort()).toMatchSnapshot();
  });

  it('snapshots the llm namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.llm).sort()).toMatchSnapshot();
  });

  it('snapshots the childRuns namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.childRuns).sort()).toMatchSnapshot();
  });

  it('snapshots the enrichment namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.enrichment).sort()).toMatchSnapshot();
  });

  it('snapshots the subrun namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.subrun).sort()).toMatchSnapshot();
  });

  it('snapshots the runSupervisor namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.runSupervisor).sort()).toMatchSnapshot();
  });

  it('snapshots the telemetry namespace', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest.telemetry).sort()).toMatchSnapshot();
  });
});
