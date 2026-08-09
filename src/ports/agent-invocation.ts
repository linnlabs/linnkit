import type { AiMessage, ReasoningEffort, RuntimeResourceRef } from '../contracts';

/**
 * Agent runtime 最小调用协议。
 *
 * 中文备注：
 * - 这里只声明 runtime-kernel / context-core 真正读取的字段；
 * - 产品层的 AgentInvokeRequest 可以通过结构类型自然满足该接口；
 * - agent package 不再从 app core 反向导入调用协议；
 * - 公共合同面不依赖产品 enum：promptKey 在 ports 层是 opaque string。
 */
export interface AgentInvocationRequest {
  query: string;
  currentUserEventId?: string;
  currentUserAttachments?: RuntimeResourceRef[];
  promptKey: string;
  model_id?: string;
  imageGenerationModelId?: string;
  maxSteps?: number;
  enableTools?: boolean;
  availableTools?: string[];
  conversationHistory?: AiMessage[];
  /** 用户选择的思考努力程度（统一语义）；null/undefined 表示走模型默认 */
  reasoning_effort?: ReasoningEffort | null;
}
