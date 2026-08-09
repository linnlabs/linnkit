import type { CanonicalLlmUsage } from '../../../contracts';

/** Host 解析注册项并执行一次上下文摘要所需的最小请求。 */
export interface SummaryGenerationRequest {
  /** Host 注册表中的摘要 Agent 标识；Linnkit 不解释其命名空间。 */
  readonly agentId: string;
  /** 已由 Linnkit 选择并格式化的待摘要历史。 */
  readonly content: string;
  /** 本次摘要必须使用的已解析模型标识。 */
  readonly modelId: string;
}

/** Host 返回给上下文摘要流程的结果。 */
export interface SummaryGenerationResponse {
  readonly summary: string;
  readonly canonicalUsage?: CanonicalLlmUsage;
}
