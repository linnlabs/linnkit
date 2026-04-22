/**
 * @file src/agent/context-manager/profiles/agent/context/providers/working-memory/types.ts
 * @description 工作记忆辅助模块的共享类型定义
 */

import type { MessageProcessingState } from '../base';
import type { ToolInteractionGroup } from '../../../utils/toolInteractionGroup';

/**
 * 工具对适配结果
 */
export interface ToolPairFitResult {
  /** 是否可以直接装入（无需处理） */
  canFit: boolean;
  /** 是否需要截断处理 */
  needsTruncation: boolean;
  /** 工具交互组 */
  group: ToolInteractionGroup<MessageProcessingState>;
  /** 工具交互组的消息状态数组 */
  pair: MessageProcessingState[];
  /** 工具交互组的总Token数 */
  totalTokens: number;
  /** 超限原因（如果适用） */
  reason?: 'budget_exceeded' | 'pair_too_large';
}

/**
 * 工具对截断结果
 */
export interface TruncationResult {
  /** 是否截断成功 */
  success: boolean;
  /** 节省的Token数 */
  tokensSaved: number;
}

/**
 * 调试日志函数类型
 */
export type DebugFn = (message: string, data?: Record<string, unknown>) => void;
