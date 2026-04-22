/**
 * @file src/agent/runtime-kernel/run-context/types.ts
 * @description 统一运行上下文定义
 *
 * 核心目标：
 * - 统一管理跨 Run（Graph执行）的链路追踪信息
 * - 支持父子任务（SubAgent）与审阅等长程业务的上下文贯穿
 * - 替代散落在各处的 review_run_id 等专用字段
 */

export interface RunContext {
  /**
   * 当前 Run 的唯一标识（对应一次 Graph 执行 / 一次 conversation turn）
   * - 通常对应 `turnId` 或 `messageId`
   */
  runId: string;

  /**
   * 链路追踪 ID（贯穿业务全流程）
   * - Review场景：对应 review_run_id（一次审阅包含多次 AI 调用）
   * - 简单对话场景：可与 conversationId 或 runId 相同
   */
  traceId: string;

  /**
   * 父级 Run ID（用于子 Agent / 嵌套图）
   * - 如果是顶层任务，则为 undefined
   */
  parentId?: string;

  /**
   * 根 Run ID（业务发起的原点）
   */
  rootRunId?: string;

  /**
   * 业务标签/元数据（业务特定的上下文挂载点）
   * - 例如：{ agentId: 'logicCheck', chunkIndex: 0 }
   * - 替代原先散落在 ToolContext 顶层的 loose fields
   */
  tags: Record<string, string | number | boolean | undefined>;
}

/**
 * 创建默认的 RunContext
 */
export function createDefaultRunContext(overrides?: Partial<RunContext>): RunContext {
  const id = `run_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return {
    runId: id,
    traceId: id,
    tags: {},
    ...overrides
  };
}
