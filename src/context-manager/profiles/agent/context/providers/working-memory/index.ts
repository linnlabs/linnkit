/**
 * @file src/agent/context-manager/profiles/agent/context/providers/working-memory/index.ts
 * @description 工作记忆辅助模块导出
 *
 * 该模块包含 AgentWorkingMemoryProvider 的辅助类：
 * - ToolPairMatcher: 工具对配对器
 * - ToolPairTruncator: 工具对截断器
 * - ReplacementSourceTagger: 替换源标记器
 * - CurrentToolInteractionRetention: P1 当前轮工具组保留策略
 * - HistoricalToolInteractionRetention: P3 历史工具组保留策略
 * - ToolGroupKeeper: 工具组保留原语
 * - TextConversationRetention: P2 文本与 thought 保留策略
 * - PostToolCallRetention: 工具执行后最近工具组优先保留策略
 */

export { ToolPairMatcher } from './ToolPairMatcher';
export { ToolPairTruncator } from './ToolPairTruncator';
export { ReplacementSourceTagger } from './ReplacementSourceTagger';
export { buildHistoricalToolCandidates } from './HistoricalToolCandidates';
export { promoteMostRecentToolPair } from './PostToolCallRetention';
export { processTextConversations } from './TextConversationRetention';
export { processToolInteractions } from './CurrentToolInteractionRetention';
export { processHistoricalToolInteractions } from './HistoricalToolInteractionRetention';
export { keepToolGroup, markWorkingMemory } from './ToolGroupKeeper';
export type {
  DebugFn,
  HistoricalToolCandidate,
  HistoricalToolRetentionResult,
  ToolInteractionRetentionResult,
  ToolPairFitResult,
  TruncationResult,
  WorkingMemoryRetentionResult,
} from './types';
