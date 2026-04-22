/**
 * @file src/agent/runtime-kernel/enrichment/types.ts
 * @description 请求增强器（Request Enricher）接口定义
 *
 * 核心目标：
 * - 将业务特定的上下文组装逻辑（如 Review 的角色解析等）从主循环剥离
 * - 提供统一的扩展点，主循环只负责调度，不感知具体业务
 */

import type { AgentInvocationRequest } from '../../ports';
import type { RunContext } from '../run-context/types';
import type { ToolContextPatch } from '../tools/toolContextPatch';

export interface EnrichmentContext {
  /**
   * 当前会话 ID
   *
   * 中文备注：
   * - RequestEnricher 的目标是"把业务特定逻辑从主循环剥离"，但它仍然是"针对某个会话的增强"；
   * - Deep Research / Review 等业务常需要读取/写入会话级状态（例如 conversations.metadata），
   *   因此把 conversationId 纳入 enrichment 上下文是结构性必需条件；
   * - 该字段是运行期上下文，不属于模型输入。
   */
  conversationId: string;
  /** 原始请求（运行时为 AgentInvokeRequest，runtime 只依赖 AgentInvocationRequest 协议面） */
  request: AgentInvocationRequest;
  /** 当前运行上下文 */
  runContext: RunContext;
}

export interface EnrichmentResult {
  /**
   * 增强后的请求对象（例如：补全了 system_prompt / knowledge 变量）
   * - 如果不需要修改，可返回原对象
   */
  request: AgentInvocationRequest;

  /**
   * 需要注入到 ToolContext 的额外数据
   * - 例如：Review 场景下的 block_map (已废弃) 或 review_run_id 等元信息
   * - 这些数据仅工具可见，模型不可见
   */
  toolContextPatch?: ToolContextPatch;

  /**
   * 对 RunContext 的更新（可选）
   * - 例如：业务层解析出了更准确的 traceId 或 tags
   */
  runContextPatch?: Partial<RunContext>;
}

/**
 * Registry 输出的最终增强结果
 *
 * 说明：
 * - `RequestEnricher.enrich()` 返回 patch（增量）
 * - Registry 会把所有 patch 串行合并，并返回最终的 `runContext`
 */
export interface RegistryEnrichmentResult {
  request: AgentInvocationRequest;
  toolContextPatch?: ToolContextPatch;
  runContext: RunContext;
}

/**
 * 请求增强器接口
 *
 * 中文备注：
 * - runtime 层只依赖 AgentInvocationRequest 协议面；
 * - 产品层 enricher 实现中，运行时收到的实际值是 AgentInvokeRequest（结构上满足 AgentInvocationRequest）；
 * - 需要访问产品级字段时，features 实现可在边界做安全窄化。
 */
export interface RequestEnricher {
  /** 增强器名称（用于调试/日志） */
  name: string;

  /**
   * 判断该增强器是否适用于当前请求
   * - 通常基于 promptKey 或 mode 判断
   */
  isApplicable(request: AgentInvocationRequest): boolean;

  /**
   * 执行增强逻辑
   * - 可以包含异步操作（查库、调 RPC 等）
   */
  enrich(context: EnrichmentContext): Promise<EnrichmentResult>;
}
