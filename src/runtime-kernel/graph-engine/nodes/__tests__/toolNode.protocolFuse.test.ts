import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLlmAuditRecorder } from '../../../../shared/llmAuditRecorder';

const { recordToolProtocolErrorMock } = vi.hoisted(() => ({
  recordToolProtocolErrorMock: vi.fn(),
}));

import {
  applyProtocolFuseState,
  checkProtocolFuse,
  createToolProtocolFuseError,
  TOOL_PROTOCOL_ERROR_FUSE_THRESHOLD,
} from '../toolNode.protocolFuse';

describe('toolNode.protocolFuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLlmAuditRecorder({
      recordToolProtocolError: recordToolProtocolErrorMock,
    });
  });

  afterEach(() => {
    setLlmAuditRecorder(null);
  });

  it('protocol error 应累计次数并记录审计', () => {
    const local: Record<string, unknown> = { _consecutiveToolProtocolErrors: 2 };

    const result = checkProtocolFuse({
      local,
      exec: { errorKind: 'protocol', error: 'missing required field' },
      toolName: 'workspace_create_document',
      toolCallId: 'call_3',
      rawArguments: '{}',
      parsedArguments: {},
    });

    expect(result).toEqual({
      isProtocolError: true,
      nextCount: 3,
      shouldFuse: false,
    });
    expect(recordToolProtocolErrorMock).toHaveBeenCalledTimes(1);
  });

  it('非 protocol error 应清零，不记录协议审计', () => {
    const local: Record<string, unknown> = { _consecutiveToolProtocolErrors: 3 };

    const result = checkProtocolFuse({
      local,
      exec: { errorKind: 'execution', error: 'timeout' },
      toolName: 'search',
      parsedArguments: {},
    });

    expect(result).toEqual({
      isProtocolError: false,
      nextCount: 0,
      shouldFuse: false,
    });
    expect(recordToolProtocolErrorMock).not.toHaveBeenCalled();
  });

  it('达到阈值后应触发熔断', () => {
    const local: Record<string, unknown> = {
      _consecutiveToolProtocolErrors: TOOL_PROTOCOL_ERROR_FUSE_THRESHOLD - 1,
    };

    const result = checkProtocolFuse({
      local,
      exec: { errorKind: 'protocol', error: 'still broken' },
      toolName: 'search',
      parsedArguments: {},
    });

    expect(result.shouldFuse).toBe(true);
    expect(result.nextCount).toBe(TOOL_PROTOCOL_ERROR_FUSE_THRESHOLD);
  });

  it('applyProtocolFuseState 应设置或清除计数器', () => {
    const local: Record<string, unknown> = {};
    applyProtocolFuseState(local, 2);
    expect(local._consecutiveToolProtocolErrors).toBe(2);

    applyProtocolFuseState(local, 0);
    expect('_consecutiveToolProtocolErrors' in local).toBe(false);
  });

  it('createToolProtocolFuseError 应产出稳定错误类型', () => {
    const error = createToolProtocolFuseError(4, 'missing required field');
    expect(error.name).toBe('ToolProtocolFuseError');
    expect(error.message).toContain('4');
    expect(error.message).toContain('missing required field');
  });
});
