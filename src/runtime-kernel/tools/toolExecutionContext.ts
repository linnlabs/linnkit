import type { ToolContextConversationView } from './conversationView';
import type { SubRunTracePublisher } from '../subrun/subrunTrace.types';
import type { ChildRunInvokerPort } from '../child-runs/types';
import type { AgentTodoSnapshot, RuntimeEvent } from '../../contracts';

/**
 * runtime-owned 工具执行上下文最小合同
 *
 * 中文备注：
 * - 这里只保留 graph-engine / tool runtime / child-run 真正需要解释执行的字段；
 * - 不包含 KnowledgeBase / Workspace / DB 等宿主服务类型；
 * - 不包含 deepSearch / research / workspaceProject 等产品语义字段。
 */
export interface ToolExecutionContext {
  /**
   * 当前对话 run 的唯一标识（由 FlowOrchestrator 注入）
   * 说明：Workspace 工具 vNext 协议已不再依赖 index 快照，但 runId 仍可用于其他链路的追踪/调试。
   */
  runId?: string;

  /**
   * 🔥 引用编号偏移量（用于多次工具调用时的连续编号）
   *
   * 工作原理：
   * - 每次调用知识库工具时,由 ToolNode 传入当前轮次已使用的引用数量
   * - 工具在格式化 observation 和构建 citations 时使用此偏移量
   * - 确保 AI 看到的编号和引用元数据的编号都是连续且一致的
   *
   * @default 0 - 表示从 1 开始编号
   */
  citationOffset?: number;

  /**
   * 🔥 取消信号（贯穿一次对话请求）
   *
   * 约定：
   * - 工具实现必须在合适的边界检查 `abortSignal.aborted` 并尽快退出；
   * - 该字段属于“执行期上下文”，不应被写入持久化事件。
   */
  abortSignal?: AbortSignal;

  /**
   * 🔥 当前这次工具调用的 tool_call_id（由 ToolNode 在执行前注入）
   *
   * 说明：
   * - tool_call_id 属于“事件层/执行层”的稳定关联键；
   * - 工具内部如果需要发布 subrun_trace（子 run 过程），必须使用该字段作为 parent_tool_call_id。
   * - 该字段仅在工具执行期间有效，不应被工具写入持久化历史。
   */
  parentToolCallId?: string;

  /**
   * 🔥 当前对话 ID（由 GraphExecutor/ToolNode 注入，用于工具内部做链路追踪）
   */
  conversationId?: string;

  /**
   * 🔥 当前轮次 ID（由 GraphExecutor/ToolNode 注入，用于工具内部做链路追踪）
   */
  turnId?: string;

  /**
   * 🔥 Agent ToDo（working memory）快照（对话级）
   *
   * 设计说明：
   * - ToDo 的权威状态应落到 RuntimeEvent（todo_updated）以便截断/回放一致；
   * - 但工具执行期间需要“读到本轮最新状态”（尚未落库），因此把最新快照同时缓存到 ToolContext。
   * - AgentRunnerService 会在每次 run 开始时用历史事件回放的最后一条 todo_updated 为其初始化。
   */
  agentTodo?: AgentTodoSnapshot;

  /**
   * 🔥 显式会话视图 capability
   *
   * 中文备注：
   * - `conversationView` 是后续统一承载 working/persisted history 的稳定协议面；
   * - 迁移期仍保留 `getConversationHistoryEvents()` 兼容旧工具。
   */
  conversationView?: ToolContextConversationView;

  /**
   * 🔥 获取父会话的历史事件（兼容 getter）
   *
   * 约束：
   * - 返回值必须被视为只读：工具不得修改数组内容；
   * - 迁移期该 getter 语义固定为 `conversationView.getWorkingHistoryEvents()`；
   * - 新代码优先直接使用 `conversationView`，避免继续把 working/persisted history 混为一个概念。
   */
  getConversationHistoryEvents?: () => ReadonlyArray<RuntimeEvent>;

  /**
   * 🔥 发布 todo_updated RuntimeEvent（低耦合注入）
   */
  publishAgentTodoUpdated?: (snapshot: AgentTodoSnapshot) => void;

  /**
   * 🔥 SubRun Trace Channel：为工具提供 publisher 工厂（低耦合）
   */
  createSubRunTracePublisher?: (opts: {
    parentToolCallId: string;
    subrunId: string;
    subrunParentId?: string;
    source?: string;
    metadata?: Record<string, unknown>;
    persistForReplay?: boolean;
  }) => SubRunTracePublisher;

  /**
   * 显式 child-run invoker 注入（迁移期优先入口）
   */
  registeredChildRunInvoker?: ChildRunInvokerPort;

  /**
   * 与 ConversationArtifactContext 等「可扩展宿主字段」交织时的结构兼容：
   * - 运行期 toolContext 常为普通对象，可能携带 sharedMemory / research 等附加键；
   * - 无此索引签名时，`ToolExecutionContext` 无法赋给 `ToolExecutionContext & ConversationArtifactContext`（strict 下报错）。
   */
  [key: string]: unknown;
}
