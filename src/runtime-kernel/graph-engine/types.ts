import type { ToolExecutionContext } from '../tools/toolExecutionContext';
import type { RuntimeEvent } from '../../contracts';

export interface ExecutorLocalState {
  stepCount: number;
  phase?: 'running' | 'force_final_answer' | 'force_tools' | string;
  maxSteps?: number;
  remainingSteps?: number;
  finalStepPolicy?: 'final_answer' | 'force_tools';
  finalStepForcedTools?: string[];
  lastStepsHintThreshold?: number;
  systemReminderRuleIds?: string[];
  runLockedModelId?: string;
}

export interface EngineLocalState extends Record<string, unknown> {
  conversationId?: string;
  turnId?: string;
  request?: Record<string, unknown>;
  toolContext?: ToolExecutionContext;
  history?: RuntimeEvent[];
  newEvents?: RuntimeEvent[];
  executorLocal?: ExecutorLocalState;
  pendingToolCalls?: StandardToolCall[];
  pendingInteractionSpec?: Record<string, unknown>;
  lastToolResult?: Record<string, unknown>;
  finalAnswer?: string;
  answerId?: string;
  chunkSeq?: number;
  signal?: AbortSignal;
  sseSink?: (evt: unknown) => RuntimeEvent[] | void;
  summarizationCallbacks?: {
    onSummarizationStart?: () => void;
    onSummarizationEnd?: (summaryInfo: unknown) => void;
  };
}

export const ENGINE_STATE_SCHEMA_VERSION = 1;

export interface EngineState {
  nodeId: string;
  /**
   * 顶层 schema version，供持久化后端在不解读 local 结构时也能快速判断版本。
   *
   * 当前 save 路径会统一写入该字段；类型先保持向后兼容，直到旧测试/fixture 全部收敛。
   */
  schemaVersion?: number;
  local?: EngineLocalState;
}

export interface NodeResult {
  kind: 'route' | 'yield' | 'pause';
  nextNodeId?: string;
  events?: RuntimeEvent[];
}

export interface GraphNode {
  id: string;
  run(state: EngineState): Promise<NodeResult>;
}

export interface StandardToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}
