import type { AiMessage } from '../contracts';

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
  promptKey: string;
  model_id?: string;
  imageGenerationModelId?: string;
  /**
   * 兼容字段。
   *
   * 当前仍允许 host 显式传入 `chat`，但长期目标不是维护两套并列核心模式；
   * 纯聊天会逐步收敛为“不给工具的 agent 形态”。
   */
  mode?: 'agent' | 'chat';
  maxSteps?: number;
  enableTools?: boolean;
  availableTools?: string[];
  conversationHistory?: AiMessage[];
}
