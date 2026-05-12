import type { AgentInvocationRequest, LlmRequestMessage } from '../../ports';
import type { RuntimeEvent } from '../../contracts';

export interface GraphExecutorSummarizationCallbacks {
  onSummarizationStart?: () => void;
  onSummarizationEnd?: (summaryInfo: unknown) => void;
}

export interface PendingContextRuntimeEvent extends Record<string, unknown> {
  id: string;
  type: string;
}

export interface GraphExecutorContextBuildInput {
  request: AgentInvocationRequest;
  history: RuntimeEvent[];
  summarizationCallbacks?: GraphExecutorSummarizationCallbacks;
  modelId: string;
  signal?: AbortSignal;
}

export interface GraphExecutorContextBuildOutput {
  mode: 'agent' | 'chat';
  llmMessages: LlmRequestMessage[];
  summaryEvents: PendingContextRuntimeEvent[];
  /**
   * 上下文构建旁路 trace。
   *
   * 中文备注：runtime-kernel 只负责透传，不理解 context-manager 的具体 trace 类型，
   * 避免 graph-engine 反向依赖 context-manager。
   */
  contextTrace?: unknown;
}

export interface GraphExecutorContextBuilder {
  build(input: GraphExecutorContextBuildInput): Promise<GraphExecutorContextBuildOutput>;
}
