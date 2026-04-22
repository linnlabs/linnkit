/**
 * ToolContext patch 的最小合同
 *
 * 中文备注：
 * - 这里表达的是“宿主/产品层希望追加到 ToolContext 上的增量字段”；
 * - 它不是完整 ToolContext，也不承诺 runtime-owned capability；
 * - 迁移期仍允许任意键，但调用方必须接受 runtime reserved keys 会被过滤。
 */
export type ToolContextPatch = Record<string, unknown>;
