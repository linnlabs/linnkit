import type { RuntimeEvent } from '../../contracts';

/**
 * 中文备注：
 * - 本文件是事件生命周期治理的唯一入口；
 * - 目标是把“是否持久化 / 是否进入上下文 / 是否属于工具决策”这些规则从散落判断收敛到单点；
 * - 后续新增事件时，优先修改这里，而不是去 bridge / orchestrator / converter / projector 各补一份条件。
 */

type TypedEvent = {
  type: string;
  metadata?: Record<string, unknown>;
  content?: string;
};

export type RuntimeEventUiProjectionKind =
  | 'hidden'
  | 'user_input'
  | 'thought'
  | 'final_answer'
  | 'final_answer_chunk'
  | 'tool_call_decision'
  | 'tool_process'
  | 'tool_output'
  | 'requires_user_interaction'
  | 'todo_updated'
  | 'subrun_trace'
  | 'error'
  | 'stream_end'
  | 'history_summary'
  | 'checkpoint_history_summary'
  | 'unsupported';

export type RuntimeEventRealtimeChannel = 'event_bus_sse' | 'none';

export interface RuntimeEventLifecycleDecision {
  uiProjectionKind: RuntimeEventUiProjectionKind;
  persist: boolean;
  replayToUi: boolean;
  enterAgentContext: boolean;
  realtimeChannel: RuntimeEventRealtimeChannel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isToolCallDecisionEvent<T extends { type: string }>(
  event: T,
): event is T & { type: 'tool_call_decision' } {
  return event.type === 'tool_call_decision';
}

export function isToolProcessEvent<T extends { type: string }>(
  event: T,
): event is T & { type: 'tool_process' } {
  return event.type === 'tool_process';
}

export function isTodoUpdatedRuntimeEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: 'todo_updated' }> {
  return event.type === 'todo_updated';
}

export function isSubRunTraceRuntimeEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: 'subrun_trace' }> {
  return event.type === 'subrun_trace';
}

export function isStreamEndRuntimeEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: 'stream_end' }> {
  return event.type === 'stream_end';
}

export function isRequiresUserInteractionRuntimeEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: 'requires_user_interaction' }> {
  return event.type === 'requires_user_interaction';
}

export function isControlRuntimeEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: 'control' }> {
  return event.type === 'control';
}

export function isHiddenUserInputEvent(event: RuntimeEvent): boolean {
  if (event.type !== 'user_input') {
    return false;
  }

  const metadata = isRecord(event.metadata) ? event.metadata : undefined;
  const ui = metadata && isRecord(metadata.ui) ? metadata.ui : undefined;
  return ui?.presentation === 'hidden';
}

export function isEmptyTerminalAssistantRuntimeEvent(event: RuntimeEvent): boolean {
  if (event.type !== 'thought' && event.type !== 'final_answer') {
    return false;
  }

  return event.content.trim().length === 0;
}

export function shouldPersistRuntimeEvent(event: RuntimeEvent): boolean {
  return describeRuntimeEventLifecycle(event).persist;
}

export function shouldReplayRuntimeEventToUi(event: RuntimeEvent): boolean {
  return describeRuntimeEventLifecycle(event).replayToUi;
}

export function shouldEnterAgentContext(event: RuntimeEvent): boolean {
  return describeRuntimeEventLifecycle(event).enterAgentContext;
}

export function shouldCreateToolCallMessage(event: TypedEvent): boolean {
  return isToolCallDecisionEvent(event);
}

export function isCheckpointHistorySummaryEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: 'history_summary' }> {
  if (event.type !== 'history_summary') {
    return false;
  }

  const metadata = isRecord(event.metadata) ? event.metadata : undefined;
  return metadata?.summary_kind === 'checkpoint';
}

export function getRuntimeEventUiProjectionKind(
  event: RuntimeEvent,
): RuntimeEventUiProjectionKind {
  if (isHiddenUserInputEvent(event)) {
    return 'hidden';
  }

  switch (event.type) {
    case 'user_input':
      return 'user_input';
    case 'thought':
      return 'thought';
    case 'final_answer':
      return 'final_answer';
    case 'final_answer_chunk':
      return 'final_answer_chunk';
    case 'tool_call_decision':
      return 'tool_call_decision';
    case 'tool_process':
      return 'tool_process';
    case 'tool_output':
      return 'tool_output';
    case 'requires_user_interaction':
      return 'requires_user_interaction';
    case 'todo_updated':
      return 'todo_updated';
    case 'subrun_trace':
      return 'subrun_trace';
    case 'error':
      return 'error';
    case 'stream_end':
      return 'stream_end';
    case 'history_summary':
      return isCheckpointHistorySummaryEvent(event)
        ? 'checkpoint_history_summary'
        : 'history_summary';
    default:
      return 'unsupported';
  }
}

export function describeRuntimeEventLifecycle(
  event: RuntimeEvent,
): RuntimeEventLifecycleDecision {
  const uiProjectionKind = getRuntimeEventUiProjectionKind(event);
  const persist = event.ephemeral !== true && !isToolProcessEvent(event);

  const replayToUi =
    uiProjectionKind !== 'hidden' &&
    uiProjectionKind !== 'final_answer_chunk' &&
    uiProjectionKind !== 'unsupported';

  const enterAgentContext = (() => {
    if (isTodoUpdatedRuntimeEvent(event)) {
      return false;
    }

    if (isSubRunTraceRuntimeEvent(event)) {
      return false;
    }

    if (isStreamEndRuntimeEvent(event)) {
      return false;
    }

    if (isRequiresUserInteractionRuntimeEvent(event)) {
      return false;
    }

    if (isControlRuntimeEvent(event)) {
      return false;
    }

    if (isHiddenUserInputEvent(event)) {
      return false;
    }

    if (isToolProcessEvent(event)) {
      return false;
    }

    if (event.type === 'final_answer_chunk') {
      return false;
    }

    if (isEmptyTerminalAssistantRuntimeEvent(event)) {
      return false;
    }

    return true;
  })();

  const realtimeChannel: RuntimeEventRealtimeChannel = (() => {
    switch (uiProjectionKind) {
      case 'thought':
      case 'final_answer':
      case 'final_answer_chunk':
      case 'tool_call_decision':
      case 'tool_process':
      case 'tool_output':
      case 'requires_user_interaction':
      case 'todo_updated':
      case 'subrun_trace':
      case 'error':
        return 'event_bus_sse';
      default:
        return 'none';
    }
  })();

  return {
    uiProjectionKind,
    persist,
    replayToUi,
    enterAgentContext,
    realtimeChannel,
  };
}

export function shouldEmitRuntimeEventToSse(event: RuntimeEvent): boolean {
  return describeRuntimeEventLifecycle(event).realtimeChannel === 'event_bus_sse';
}
