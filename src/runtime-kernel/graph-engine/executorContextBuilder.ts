import type {
  AgentInvocationRequest,
  ImageInputAdmissionEvidence,
  LlmRequestMessage,
} from '../../ports';
import type {
  ContextBuildTokenEstimate,
  ContextComponentTokenLedgerEntry,
  ContextTokenComponent,
  InternalLlmCallUsage,
  RuntimeEvent,
  SummarizationCallbacks,
} from '../../contracts';

export interface PendingContextRuntimeEvent extends Record<string, unknown> {
  id: string;
  type: string;
}

export interface GraphExecutorOutputProcessor {
  /**
   * 中文备注：outputProcessor 来自 host task 实例，方法可能依赖 `this`。
   * runtime-kernel 调用时必须保留对象接收者，不要拆成裸函数传递。
   */
  processResponse?(this: GraphExecutorOutputProcessor, rawResponse: string): string;
  processStreamChunk?(this: GraphExecutorOutputProcessor, chunk: string): string;
}

export interface GraphExecutorContextBuildInput {
  request: AgentInvocationRequest;
  history: RuntimeEvent[];
  summarizationCallbacks?: SummarizationCallbacks;
  modelId: string;
  signal?: AbortSignal;
}

export interface GraphExecutorContextBuildOutput {
  llmMessages: LlmRequestMessage[];
  /** Context Manager 产出的短生命周期图片预算证据；不得写入 checkpoint 或 provider options。 */
  imageInputAdmissionEvidence?: ImageInputAdmissionEvidence;
  summaryEvents: PendingContextRuntimeEvent[];
  /**
   * Host 注入的输出文本处理器。
   *
   * 中文备注：
   * - runtime-kernel 只知道“把模型输出字符串交给一个可选函数处理”；
   * - 具体规则仍由 host 的 agent/task 定义提供，避免 framework 反向识别 promptKey 或产品语义。
   */
  outputProcessor?: GraphExecutorOutputProcessor;
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
  /**
   * context build 内部 LLM 调用 usage。
   *
   * 中文备注：runtime 只在 build stage 为这些调用补发 telemetry；它们不进入 RuntimeEvent，
   * 避免把审计数据写入模型上下文或历史事件。
   */
  internalLlmCalls?: InternalLlmCallUsage[];
}

export interface GraphExecutorContextBuilder {
  build(input: GraphExecutorContextBuildInput): Promise<GraphExecutorContextBuildOutput>;
}
