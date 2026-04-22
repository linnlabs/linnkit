import { describe, expect, it } from 'vitest';

import {
  ENGINE_ERROR_CODES,
  ErrorCategory,
  ErrorClassifier,
} from '../errorClassifier';

describe('ErrorClassifier contract', () => {
  it('exposes stable engine error codes', () => {
    expect(ENGINE_ERROR_CODES).toMatchObject({
      LLM_RATE_LIMIT: 'llm.rate_limit',
      LLM_INVALID_TOOL_ARGS: 'llm.invalid_tool_args',
      LLM_PROVIDER_DOWN: 'llm.provider_down',
      LLM_UNSUPPORTED_CAPABILITY: 'llm.unsupported_capability',
      LLM_AUTH_FAILED: 'llm.auth_failed',
      LLM_INVALID_REQUEST: 'llm.invalid_request',
      LLM_RESOURCE_NOT_FOUND: 'llm.resource_not_found',
      TOOL_TIMEOUT: 'tool.timeout',
      ENGINE_UNKNOWN: 'engine.unknown',
    });
  });

  it('returns structured metadata for retryable llm tool-args corruption', () => {
    const result = ErrorClassifier.classify(
      new Error('invalid tool_call.arguments: trailing comma'),
    );

    expect(result).toEqual({
      category: ErrorCategory.RETRYABLE,
      reason: '模型输出损坏: invalid tool_call.arguments',
      suggestedDelay: 1000,
      errorCode: ENGINE_ERROR_CODES.LLM_INVALID_TOOL_ARGS,
      recoverable: true,
      retryAfterMs: 1000,
      hint: 'retry_with_same_request',
      metadata: {
        matchedPattern: 'invalid tool_call.arguments',
      },
    });
  });

  it('returns structured metadata for rate-limit errors', () => {
    const result = ErrorClassifier.classify(new Error('429 rate limit exceeded'));

    expect(result.category).toBe(ErrorCategory.RATE_LIMIT);
    expect(result.errorCode).toBe(ENGINE_ERROR_CODES.LLM_RATE_LIMIT);
    expect(result.recoverable).toBe(true);
    expect(result.retryAfterMs).toBe(1000);
    expect(result.hint).toBe('retry_with_backoff');
    expect(result.metadata).toEqual({
      matchedPattern: 'rate limit',
    });
  });

  it('returns structured metadata for auth failures', () => {
    const result = ErrorClassifier.classify(new Error('invalid api key'));

    expect(result.category).toBe(ErrorCategory.NON_RETRYABLE);
    expect(result.errorCode).toBe(ENGINE_ERROR_CODES.LLM_AUTH_FAILED);
    expect(result.recoverable).toBe(false);
    expect(result.retryAfterMs).toBeUndefined();
    expect(result.hint).toBe('check_credentials');
  });

  it('falls back to engine.unknown for unclassified errors', () => {
    const result = ErrorClassifier.classify(new Error('totally unexpected boom'));

    expect(result.category).toBe(ErrorCategory.NON_RETRYABLE);
    expect(result.errorCode).toBe(ENGINE_ERROR_CODES.ENGINE_UNKNOWN);
    expect(result.recoverable).toBe(false);
    expect(result.metadata).toEqual({
      matchedPattern: 'fallback',
    });
  });
});
