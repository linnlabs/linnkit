/**
 * @file src/agent/context-manager/profiles/agent/context/providers/working-memory/index.ts
 * @description 工作记忆辅助模块导出
 *
 * 该模块包含 AgentWorkingMemoryProvider 的辅助类：
 * - ToolPairMatcher: 工具对配对器
 * - ToolPairTruncator: 工具对截断器
 * - ReplacementSourceTagger: 替换源标记器
 */

export { ToolPairMatcher } from './ToolPairMatcher';
export { ToolPairTruncator } from './ToolPairTruncator';
export { ReplacementSourceTagger } from './ReplacementSourceTagger';
export type { ToolPairFitResult, TruncationResult, DebugFn } from './types';
