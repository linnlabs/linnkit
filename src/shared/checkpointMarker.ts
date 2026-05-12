/**
 * @file shared/checkpointMarker.ts
 * @description 上下文 checkpoint 的跨模块共享协议常量。
 */

export const CHECKPOINT_MARKER_TYPE = 'context_checkpoint' as const;
export const DEFAULT_CONTEXT_CHECKPOINT_TOOL_NAME = CHECKPOINT_MARKER_TYPE;
