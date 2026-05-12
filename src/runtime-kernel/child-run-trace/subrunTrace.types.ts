import type { SubRunTraceEvent } from '../../contracts';

/**
 * 子 run trace 的“业务无关”发布载荷。
 *
 * 说明：
 * - 该结构刻意只包含 subrun_trace 的 payload 字段（不包含 conversation_id/turn_id 等基础字段）
 * - parent_tool_call_id/subrun_id 是发布器构造时绑定的，不需要每次 publish 重复提供
 */
export interface SubRunTraceEnvelope {
  /** 分片类型 */
  kind: SubRunTraceEvent['kind'];
  /** 增量文本（kind=*_delta 时使用） */
  delta?: string;
  /** 完整文本（kind=*_complete/final_answer 时使用） */
  content?: string;

  /** 关联工具名（kind=tool_call_decision/tool_process/tool_output 时使用） */
  tool_name?: string;
  /** 关联工具调用 ID（子 run 内部的 tool_call_id，用于展示步骤） */
  tool_call_id?: string;
  /** 工具调用阶段（kind=tool_call_decision/tool_process 时使用） */
  phase?: SubRunTraceEvent['phase'];
  /** 工具调用状态（kind=tool_call_decision/tool_process/tool_output 时使用） */
  status?: SubRunTraceEvent['status'];

  /** 工具参数（结构不做强约束，避免与业务强耦合） */
  args?: unknown;
  /** 工具输出（结构不做强约束，避免与业务强耦合） */
  output?: unknown;
  /** 执行耗时（毫秒） */
  duration_ms?: number;

  /** 可选调试/渲染元信息 */
  meta?: Record<string, unknown>;
}

/**
 * 子 run trace 发布器接口（面向业务工具层）。
 *
 * 约束：
 * - 发布器必须确保生成的 RuntimeEvent 为 `type='subrun_trace'` 且 `ephemeral=true`
 * - 发布器应保证每条事件的 id 唯一（用于前端 processedEvents 幂等去重）
 */
export interface SubRunTracePublisher {
  publish(envelope: SubRunTraceEnvelope): void;
}
