import type { AgentInvocationRequest, LlmRequestMessage } from '../../ports';
import type {
  ContextBuildTokenEstimate,
  ContextComponentTokenLedgerEntry,
  ContextTokenComponent,
  RuntimeEvent,
} from '../../contracts';

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
  /**
   * 构建期 token 估算快照。
   *
   * 中文备注：runtime-kernel 只透传稳定 DTO；它不解析 context-manager 内部 trace，
   * 也不把 provider remote count 当成本地估算样本来源。
   */
  tokenEstimate?: ContextBuildTokenEstimate;
  /**
   * 构建期上下文分项 token 估算。
   *
   * 中文备注：context-manager 只产稳定 DTO，runtime-kernel 在带 run/turn scope 的地方
   * 再创建账本条目，避免反向读取 ContextTrace 内部结构。
   */
  tokenComponents?: ContextTokenComponent[];
  tokenLedgerEntry?: ContextComponentTokenLedgerEntry;
}

export interface GraphExecutorContextBuilder {
  build(input: GraphExecutorContextBuildInput): Promise<GraphExecutorContextBuildOutput>;
}
