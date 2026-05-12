import type { ToolExecutionContext } from '../tools/toolExecutionContext';
import type { ToolContextCompatibilityFields } from '../tools/toolContextCompatibility';
import type { ToolContextPatch } from '../tools/toolContextPatch';
import type { RuntimeEvent } from '../../contracts';

/**
 * child-run 父上下文的 runtime-owned 最小合同
 *
 * 中文备注：
 * - 这里只声明 child-run 协议真正需要的 runtime capability / compatibility fields；
 * - 不显式依赖完整 ToolContext，避免 child-run 主链编译期吃进整套 host/product 服务类型；
 * - 仍保留 index signature，用于在创建 child ToolContext 时透传宿主/产品层 patch。
 */
export interface ChildRunParentContext extends ToolExecutionContext, ToolContextCompatibilityFields {
  deepSearchDepth?: number;
  [key: string]: unknown;
}

/**
 * child-run 内部真正注入到 GraphExecutor.local.toolContext 的最小合同。
 *
 * 中文备注：
 * - 这里表达的是“子 run 执行期间需要携带的 runtime capability + compatibility fields + inherited patch”；
 * - 它不是完整 ToolContext，不应在 runtime-kernel 主链继续引入 host/product 服务类型；
 * - 具体产品工具在运行时仍可读到宿主透传下来的服务字段，但这些字段不在 child-run 协议层显式声明。
 */
export type ChildRunToolContext = ToolExecutionContext & ToolContextCompatibilityFields & ToolContextPatch & {
  deepSearchDepth?: number;
};

export interface ChildRunHistoryPolicy {
  inheritTurns: number;
  eventFilter?: (event: RuntimeEvent) => boolean;
}

export interface ChildRunTracePolicy {
  parentToolCallId?: string;
  subrunId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  persistForReplay?: boolean;
}

export interface ChildRunExecutionPolicy {
  /**
   * 显式 child-run runId。默认由 host adapter 取 subrunId。
   */
  runId?: string;
  /**
   * 父 runId。默认从 parentToolContext.runId 继承。
   */
  parentRunId?: string;
  maxSteps?: number;
  modelId?: string;
  abortSignal?: AbortSignal;
}

export interface ChildRunRequest<TParentToolContext = ChildRunParentContext> {
  userMessage: string;
  parentToolContext: TParentToolContext;
  historyPolicy?: ChildRunHistoryPolicy;
  tracePolicy?: ChildRunTracePolicy;
  executionPolicy?: ChildRunExecutionPolicy;
}

export interface ChildRunResult {
  runId?: string;
  parentRunId?: string;
  subrunId: string;
  success: boolean;
  finalAnswer: string;
  events: RuntimeEvent[];
  stepCount: number;
  error?: string;
  judgeToolOutput?: string;
}

export interface ChildRunInvokerPort<
  TRequest extends ChildRunRequest = ChildRunRequest,
  TResult extends ChildRunResult = ChildRunResult,
> {
  invoke(params: TRequest): Promise<TResult>;
}
