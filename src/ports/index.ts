export type { AgentInvocationRequest } from './agent-invocation';
export type { AgentAiEngine, AgentAiEngineStreamContent } from './ai-engine';

/**
 * AI 引擎协议参数 type（`AgentAiEngine` 的入参形状）。
 *
 * 归位说明（2026-04-23）：这 5 个 type 的 definitive source 原本在
 * `runtime-kernel/llm/caller.types.ts`，但它们的语义是 "host 实现 AgentAiEngine
 * 时要填的参数"，属于 ports 协议面。归位到 ports 后解决了 ports ⇄ runtime-kernel
 * 反向循环依赖。`runtime-kernel/llm/index.ts` 继续 re-export 这些 type，保证
 * `import { llm } from 'linnkit/runtime-kernel'` 后 `llm.LlmCallOptions` 的
 * namespace 访问语法不变。
 */
export type {
  LlmCallOptions,
  LlmRequestMessage,
  LlmResponseContent,
  LlmRetryConfig,
  ProviderReasoningDetails,
  ToolCall,
  ToolCallChunk,
  ToolCallExtraContent,
} from './ai-engine.types';
