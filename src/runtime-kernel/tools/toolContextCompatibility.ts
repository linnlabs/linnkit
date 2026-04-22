import type { RunContext } from '../run-context/types';

export interface ToolContextCompatibilityFields {
  /**
   * 兼容字段：原始用户请求
   *
   * 中文备注：
   * - 当前由 host context injection 写入；
   * - 仍有少量 deep_search 调用方在读取；
   * - 后续应继续收窄，不再扩散新的读取点。
   */
  user_query?: string;

  /**
   * 兼容字段：当前 run 选定模型 ID
   *
   * 中文备注：
   * - 当前主要给 child-run 调用方继承父模型选择；
   * - 后续应继续收窄到显式 child-run execution policy。
   */
  modelId?: string;

  /**
   * 兼容字段：当前 runContext
   *
   * 中文备注：
   * - 当前主要由 host 注入；尚未在工具侧广泛直接读取；
   * - 保留显式字段是为了停止继续依赖 string-index loose access。
   */
  run_context?: RunContext;
}

type CompatibilityCarrier = ToolContextCompatibilityFields | Record<string, unknown> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRunContext(value: unknown): value is RunContext {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.runId !== 'string' || typeof value.traceId !== 'string') {
    return false;
  }
  return isRecord(value.tags);
}

export function readToolContextUserQuery(context: CompatibilityCarrier): string | undefined {
  if (!context) {
    return undefined;
  }
  return readNonEmptyString(context['user_query']);
}

export function readToolContextModelId(context: CompatibilityCarrier): string | undefined {
  if (!context) {
    return undefined;
  }
  return readNonEmptyString(context['modelId']);
}

export function readToolContextRunContext(context: CompatibilityCarrier): RunContext | undefined {
  if (!context) {
    return undefined;
  }
  const runContext = context['run_context'];
  return isRunContext(runContext) ? runContext : undefined;
}
