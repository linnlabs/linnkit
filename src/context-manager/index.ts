// === 共享层（agent/chat 之间共用的契约与工具） ===
export * from './shared';

// === 命名空间导出（保留强分层信号，便于 deep navigation） ===
export * as agentContracts from './profiles/agent/contracts';
export * as agentConfig from './profiles/agent/config';
export * as agentContext from './profiles/agent/context';
export * as agentOrchestration from './profiles/agent/orchestration';
export * as agentPreprocessors from './profiles/agent/preprocessors';
export * as agentTasks from './profiles/agent/tasks';
export * as agentTools from './profiles/agent/tools';
export * as agentUtils from './profiles/agent/utils';

export * as chatContracts from './profiles/chat/contracts';
export * as chatContext from './profiles/chat/context';
export * as chatOrchestration from './profiles/chat/orchestration';
export * as chatPreprocessors from './profiles/chat/preprocessors';
export * as chatTasks from './profiles/chat/tasks';
export * as chatUtils from './profiles/chat/utils';
export * as chatRequestAdapters from './profiles/chat/request-adapters';

// === 扁平 re-export（被消费方实际使用的公开符号） ===
// 显式列出而非 `export *`，避免 agent/chat profile 之间潜在同名冲突。
// 命名上保持源符号名 1:1。
export { AGENT_CONSTANTS } from './profiles/agent/config';
export { AGENT_CONTEXT_BUILDER_CONFIG } from './profiles/agent/context/config';
export { BaseContextProvider } from './profiles/agent/context/providers/base';
export type {
  IContextProvider,
  MessageProcessingState,
  ProviderContext,
  ProviderResult,
} from './profiles/agent/context/providers/base';

export type {
  ChatMessage,
  GenerateRequest,
} from './profiles/chat/contracts';
export { getDefaultTokenConfig } from './profiles/chat/context/config';
export { chatMessageToAiMessage } from './profiles/chat/utils/messageAdapters';
