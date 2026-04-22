/**
 * @file src/agent/shared/errorClassifier.ts
 *
 * @brief Agent runtime 自己拥有的错误分类器
 *
 * @description
 * 错误分类与重试策略属于 Agent runtime 的执行协议，不应该继续由 app shared owner 持有。
 */

export enum ErrorCategory {
  RETRYABLE = 'retryable',
  NON_RETRYABLE = 'non_retryable',
  RATE_LIMIT = 'rate_limit',
}

export const ENGINE_ERROR_CODES = {
  LLM_RATE_LIMIT: 'llm.rate_limit',
  LLM_INVALID_TOOL_ARGS: 'llm.invalid_tool_args',
  LLM_PROVIDER_DOWN: 'llm.provider_down',
  LLM_UNSUPPORTED_CAPABILITY: 'llm.unsupported_capability',
  LLM_AUTH_FAILED: 'llm.auth_failed',
  LLM_INVALID_REQUEST: 'llm.invalid_request',
  LLM_RESOURCE_NOT_FOUND: 'llm.resource_not_found',
  TOOL_TIMEOUT: 'tool.timeout',
  TOOL_PROTOCOL_FUSE: 'tool.protocol_fuse',
  ENGINE_DELEGATE_DEPTH: 'engine.delegate_depth_exceeded',
  ENGINE_BUDGET_EXHAUSTED: 'engine.budget_exhausted',
  USER_CANCELLED: 'user.cancelled',
  ENGINE_UNKNOWN: 'engine.unknown',
} as const;

export interface ErrorClassification {
  category: ErrorCategory;
  reason: string;
  suggestedDelay: number | null;
  errorCode: string;
  recoverable: boolean;
  retryAfterMs?: number;
  hint?: string;
  metadata?: Record<string, unknown>;
}

type ClassificationExtras = Omit<ErrorClassification, 'category' | 'reason' | 'suggestedDelay'>;

function createClassification(
  category: ErrorCategory,
  reason: string,
  suggestedDelay: number | null,
  extras: ClassificationExtras,
): ErrorClassification {
  return {
    category,
    reason,
    suggestedDelay,
    ...extras,
  };
}

export class ErrorClassifier {
  static classify(error: Error, context?: { logPrefix?: string }): ErrorClassification {
    type UnknownRecord = Record<string, unknown>;
    const isRecord = (v: unknown): v is UnknownRecord => !!v && typeof v === 'object' && !Array.isArray(v);

    const baseMsg = (error.message || '').toLowerCase();
    const causeMsg = (() => {
      const cause = (error as unknown as { cause?: unknown }).cause;
      if (typeof cause === 'string') return cause.toLowerCase();
      if (cause instanceof Error) return (cause.message || '').toLowerCase();
      if (isRecord(cause) && typeof cause['message'] === 'string') return String(cause['message']).toLowerCase();
      return '';
    })();
    const causeCode = (() => {
      const cause = (error as unknown as { cause?: unknown }).cause;
      if (isRecord(cause) && typeof cause['code'] === 'string') return String(cause['code']);
      return '';
    })();

    const errorMessage = `${baseMsg} ${causeMsg}`.trim();
    const logPrefix = context?.logPrefix || '[ErrorClassifier]';

    if (errorMessage.includes('invalid tool_call.arguments')) {
      console.log(`${logPrefix} 🔄 检测到流式 tool_call 参数损坏，可以重试`);
      return createClassification(ErrorCategory.RETRYABLE, '模型输出损坏: invalid tool_call.arguments', 1000, {
        errorCode: ENGINE_ERROR_CODES.LLM_INVALID_TOOL_ARGS,
        recoverable: true,
        retryAfterMs: 1000,
        hint: 'retry_with_same_request',
        metadata: { matchedPattern: 'invalid tool_call.arguments' },
      });
    }

    const unsupportedPatterns = [
      'no channels with claude tools support',
      'does not support',
      'not supported',
      'tool calling is not available',
      'feature not available',
      'capability not supported',
      'unsupported',
    ];

    for (const pattern of unsupportedPatterns) {
      if (errorMessage.includes(pattern)) {
        console.log(`${logPrefix} 🚫 检测到功能不支持错误，不重试`);
        return createClassification(ErrorCategory.NON_RETRYABLE, `功能不支持: ${pattern}`, null, {
          errorCode: ENGINE_ERROR_CODES.LLM_UNSUPPORTED_CAPABILITY,
          recoverable: false,
          hint: 'switch_model_or_disable_feature',
          metadata: { matchedPattern: pattern },
        });
      }
    }

    const quotaPatterns = ['已达上限', '免费期已结束'];
    for (const pattern of quotaPatterns) {
      if (errorMessage.includes(pattern)) {
        console.log(`${logPrefix} 🚫 检测到云端额度限制，不重试`);
        return createClassification(ErrorCategory.NON_RETRYABLE, `云端额度限制: ${pattern}`, null, {
          errorCode: ENGINE_ERROR_CODES.LLM_PROVIDER_DOWN,
          recoverable: false,
          hint: 'check_billing_or_provider_status',
          metadata: { matchedPattern: pattern },
        });
      }
    }

    const authPatterns = [
      { pattern: 'unauthorized', code: '401' },
      { pattern: 'forbidden', code: '403' },
      { pattern: 'invalid api key', code: 'auth' },
      { pattern: 'invalid_api_key', code: 'auth' },
      { pattern: 'authentication failed', code: 'auth' },
      { pattern: 'api key not found', code: 'auth' },
    ];

    for (const { pattern, code } of authPatterns) {
      if (errorMessage.includes(pattern)) {
        console.log(`${logPrefix} 🚫 检测到认证/权限错误 (${code})，不重试`);
        return createClassification(ErrorCategory.NON_RETRYABLE, `认证/权限错误: ${pattern}`, null, {
          errorCode: ENGINE_ERROR_CODES.LLM_AUTH_FAILED,
          recoverable: false,
          hint: 'check_credentials',
          metadata: { matchedPattern: pattern, authCode: code },
        });
      }
    }

    const formatPatterns = [
      'bad request',
      '400',
      'invalid request',
      'invalid parameter',
      'invalid arguments for function',
      'convert_request_failed',
      'validation error',
      'malformed',
      'invalid json',
      'parse error',
      'schema validation failed',
    ];

    for (const pattern of formatPatterns) {
      if (errorMessage.includes(pattern)) {
        console.log(`${logPrefix} 🚫 检测到请求格式错误，不重试`);
        return createClassification(ErrorCategory.NON_RETRYABLE, `请求格式错误: ${pattern}`, null, {
          errorCode: ENGINE_ERROR_CODES.LLM_INVALID_REQUEST,
          recoverable: false,
          hint: 'fix_request_payload',
          metadata: { matchedPattern: pattern },
        });
      }
    }

    const notFoundPatterns = [
      'not found',
      '404',
      'model not found',
      'endpoint not found',
      'resource not found',
    ];

    for (const pattern of notFoundPatterns) {
      if (errorMessage.includes(pattern)) {
        console.log(`${logPrefix} 🚫 检测到资源不存在错误，不重试`);
        return createClassification(ErrorCategory.NON_RETRYABLE, `资源不存在: ${pattern}`, null, {
          errorCode: ENGINE_ERROR_CODES.LLM_RESOURCE_NOT_FOUND,
          recoverable: false,
          hint: 'verify_resource_identifier',
          metadata: { matchedPattern: pattern },
        });
      }
    }

    const rateLimitPatterns = [
      'rate limit',
      'too many requests',
      '429',
      'quota exceeded',
      'throttled',
    ];

    for (const pattern of rateLimitPatterns) {
      if (errorMessage.includes(pattern)) {
        console.log(`${logPrefix} ⏱️ 检测到速率限制错误，将使用指数退避重试`);
        return createClassification(ErrorCategory.RATE_LIMIT, `速率限制: ${pattern}`, 1000, {
          errorCode: ENGINE_ERROR_CODES.LLM_RATE_LIMIT,
          recoverable: true,
          retryAfterMs: 1000,
          hint: 'retry_with_backoff',
          metadata: { matchedPattern: pattern },
        });
      }
    }

    const networkPatterns = [
      'network error',
      'timeout',
      'econnrefused',
      'econnreset',
      'etimedout',
      'connection refused',
      'connection reset',
      'socket hang up',
      'fetch failed',
      'network timeout',
      'terminated',
      'other side closed',
    ];

    for (const pattern of networkPatterns) {
      if (errorMessage.includes(pattern)) {
        console.log(`${logPrefix} 🔄 检测到网络错误，可以重试`);
        return createClassification(ErrorCategory.RETRYABLE, `网络错误: ${pattern}`, 1000, {
          errorCode: ENGINE_ERROR_CODES.LLM_PROVIDER_DOWN,
          recoverable: true,
          retryAfterMs: 1000,
          hint: 'retry_with_backoff',
          metadata: { matchedPattern: pattern },
        });
      }
    }

    if (causeCode.startsWith('UND_ERR_')) {
      console.log(`${logPrefix} 🔄 检测到 undici 错误码(${causeCode})，可以重试`);
      return createClassification(ErrorCategory.RETRYABLE, `网络错误(undici): ${causeCode}`, 1000, {
        errorCode: ENGINE_ERROR_CODES.LLM_PROVIDER_DOWN,
        recoverable: true,
        retryAfterMs: 1000,
        hint: 'retry_with_backoff',
        metadata: { matchedPattern: causeCode },
      });
    }

    const serverErrorPatterns = [
      { pattern: '500', name: 'Internal Server Error' },
      { pattern: '502', name: 'Bad Gateway' },
      { pattern: '503', name: 'Service Unavailable' },
      { pattern: '504', name: 'Gateway Timeout' },
      { pattern: 'internal server error', name: 'Internal Server Error' },
      { pattern: 'bad gateway', name: 'Bad Gateway' },
      { pattern: 'service unavailable', name: 'Service Unavailable' },
      { pattern: 'gateway timeout', name: 'Gateway Timeout' },
    ];

    for (const { pattern, name } of serverErrorPatterns) {
      if (errorMessage.includes(pattern)) {
        console.log(`${logPrefix} 🔄 检测到服务端临时错误 (${name})，可以重试`);
        return createClassification(ErrorCategory.RETRYABLE, `服务端临时错误: ${name}`, 2000, {
          errorCode: ENGINE_ERROR_CODES.LLM_PROVIDER_DOWN,
          recoverable: true,
          retryAfterMs: 2000,
          hint: 'retry_with_backoff',
          metadata: { matchedPattern: pattern },
        });
      }
    }

    if (errorMessage.includes('空响应') || errorMessage.includes('empty response')) {
      console.log(`${logPrefix} 🔄 检测到空响应错误，可以重试`);
      return createClassification(ErrorCategory.RETRYABLE, '空响应错误', 1000, {
        errorCode: ENGINE_ERROR_CODES.LLM_PROVIDER_DOWN,
        recoverable: true,
        retryAfterMs: 1000,
        hint: 'retry_with_backoff',
        metadata: { matchedPattern: 'empty response' },
      });
    }

    const truncatedMessage =
      errorMessage.length > 100 ? `${errorMessage.substring(0, 100)}...` : errorMessage;

    console.log(`${logPrefix} ⚠️ 未知错误类型，默认不重试以避免浪费: ${truncatedMessage}`);
    return createClassification(ErrorCategory.NON_RETRYABLE, '未知错误类型（保守策略）', null, {
      errorCode: ENGINE_ERROR_CODES.ENGINE_UNKNOWN,
      recoverable: false,
      hint: 'inspect_logs',
      metadata: { matchedPattern: 'fallback' },
    });
  }

  static categorize(error: Error): ErrorCategory {
    return this.classify(error).category;
  }

  static shouldRetry(error: Error): boolean {
    const category = this.categorize(error);
    return category === ErrorCategory.RETRYABLE || category === ErrorCategory.RATE_LIMIT;
  }

  static calculateRetryDelay(
    error: Error,
    attemptNumber: number,
    baseDelay: number = 1000,
    maxDelay: number = 60000,
  ): number {
    const classification = this.classify(error);

    if (classification.category === ErrorCategory.NON_RETRYABLE) {
      return 0;
    }

    if (classification.category === ErrorCategory.RATE_LIMIT) {
      return Math.min(baseDelay * Math.pow(2, attemptNumber), maxDelay);
    }

    return classification.suggestedDelay || baseDelay;
  }

  static isCloudQuotaError(error: Error): boolean {
    const msg = (error.message || '').toLowerCase();
    const patterns = [
      '额度上限',
      '已达上限',
      '免费期已结束',
      '该模型暂不可用',
    ];
    return patterns.some((pattern) => msg.includes(pattern));
  }
}

export const classifyError = (error: Error) => ErrorClassifier.classify(error);
export const categorizeError = (error: Error) => ErrorClassifier.categorize(error);
export const shouldRetryError = (error: Error) => ErrorClassifier.shouldRetry(error);
