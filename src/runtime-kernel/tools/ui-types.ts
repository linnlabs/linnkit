/**
 * @file src/agent/runtime-kernel/tools/ui-types.ts
 *
 * @brief 定义工具在前端UI展示时所需的元数据类型
 *
 * @description
 * 这个文件中的类型专门用于 "后端驱动UI (Backend-Driven UI)" 架构。
 * 当后端Agent执行一个工具时，它会附带这些UI元数据。
 * 前端则根据这些元数据，动态地、智能地渲染出对应的UI组件，
 * 从而实现工具展示逻辑与前端渲染逻辑的解耦。
 */

export interface ToolLayoutOptions {
  contentPadding?: boolean;
  showBorder?: boolean;
  showBackground?: boolean;
}

export interface ToolDisplayOptions {
  viewType: string;
  titleTemplate?: string;
  icon?: string;
  layout?: ToolLayoutOptions;
}

export interface ToolControlInfo {
  requireUser?: boolean;
  questionnaireId?: string;
  resumeStrategy?: 'continue';
  terminateRun?: boolean;
  reason?: string;
}

export interface StructuredToolResult<T = Record<string, unknown>> {
  data: T;
  observation?: string;
  control?: ToolControlInfo;
}
