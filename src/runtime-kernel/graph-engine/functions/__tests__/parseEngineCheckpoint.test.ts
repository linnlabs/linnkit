import { describe, expect, it } from 'vitest';
import { parseEngineCheckpoint } from '../parseEngineCheckpoint';

describe('persisted checkpoint admission', () => {
  it('保留原工具位置和累计预算，拒绝损坏的恢复字段与能力对象', () => {
    const state = {
      nodeId: 'tool', schemaVersion: 1, revision: 8, executionStatus: 'executing',
      local: { executorLocal: { stepCount: 7, maxSteps: 20, runLockedModelId: 'original' },
        executingToolCallId: 'call', pendingToolCalls: [{ id: 'call', type: 'function', function: { name: 'write', arguments: '{}' } }],
        request: { query: 'original' }, history: [], customState: { page: 2 } },
    };
    expect(parseEngineCheckpoint(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => parseEngineCheckpoint({ ...state, schemaVersion: 99 })).toThrow();
    expect(() => parseEngineCheckpoint({ ...state, revision: -1 })).toThrow();
    expect(() => parseEngineCheckpoint({ ...state, local: { executorLocal: { stepCount: '7' } } })).toThrow();
    expect(() => parseEngineCheckpoint({ ...state, local: { signal: {} } })).toThrow('capability');
    expect(() => parseEngineCheckpoint({ ...state, local: { request: { callback: () => {} } } })).toThrow();
  });
});
