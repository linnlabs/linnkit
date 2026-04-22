/**
 * tool schema 生成阶段的最小上下文合同
 *
 * 中文备注：
 * - 这里只承载“生成工具 schema 时需要读到的上下文”；
 * - 当前已知稳定字段只有 `imageGenerationModelId`；
 * - 不应把完整 `ToolContext` 透传给 schema generation。
 */
export interface ToolSchemaContext {
  imageGenerationModelId?: string;
  [key: string]: unknown;
}
