import { describe, expect, it } from 'vitest';
import { parseEngineCheckpoint } from '../parseEngineCheckpoint';

describe('persisted checkpoint admission', () => {
  it('保留原工具位置和累计预算，拒绝损坏的恢复字段与能力对象', () => {
    const state = {
      nodeId: 'tool', schemaVersion: 1, revision: 8, executionStatus: 'executing',
      local: { executorLocal: { stepCount: 7, maxSteps: 20 },
        executingToolCallIds: ['call'], pendingToolCalls: [{ id: 'call', type: 'function', function: { name: 'write', arguments: '{}' } }],
        request: { query: 'original' }, history: [], customState: { page: 2 } },
    };
    expect(parseEngineCheckpoint(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => parseEngineCheckpoint({ ...state, schemaVersion: 99 })).toThrow();
    expect(() => parseEngineCheckpoint({ ...state, revision: -1 })).toThrow();
    expect(() => parseEngineCheckpoint({ ...state, local: { executorLocal: { stepCount: '7' } } })).toThrow();
    expect(() => parseEngineCheckpoint({ ...state, local: { signal: {} } })).toThrow('capability');
    expect(() => parseEngineCheckpoint({ ...state, local: { request: { callback: () => {} } } })).toThrow();
  });

  it('0.47 及更早只记一个在途调用的断点读入后成为单成员集合；两种写法并存视为损坏', () => {
    const legacy = {
      nodeId: 'tool', schemaVersion: 1, revision: 3, executionStatus: 'executing',
      local: { executingToolCallId: 'call-1',
        pendingToolCalls: [{ id: 'call-1', type: 'function', function: { name: 'write', arguments: '{}' } }] },
    };
    const parsed = parseEngineCheckpoint(legacy);
    expect(parsed.local?.executingToolCallIds).toEqual(['call-1']);
    expect(parsed.local).not.toHaveProperty('executingToolCallId');
    expect(() => parseEngineCheckpoint({
      ...legacy, local: { ...legacy.local, executingToolCallIds: ['call-1'] },
    })).toThrow('executingToolCallId');
  });

  it('旧 checkpoint 带已删除的 lastSuccessfulLlmModelId 与云端额度兜底留下的 runLockedModelId 时照常恢复并丢弃', () => {
    const parsed = parseEngineCheckpoint({
      nodeId: 'llm',
      local: { executorLocal: { stepCount: 3, runLockedModelId: 'locked', lastSuccessfulLlmModelId: 'old-model' } },
    });
    // 兜底已移除：恢复后按请求的模型继续，不再沿用旧锁定。
    expect(parsed.local?.executorLocal).toEqual({ stepCount: 3 });
  });
});
