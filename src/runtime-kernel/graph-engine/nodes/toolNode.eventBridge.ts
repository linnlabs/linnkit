import type {
  ToolProcessEvent as AgentToolProcessEvent,
  ObservationEvent as AgentObservationEvent,
} from '../../events/agentEvents';
import { eventMapper, type EventMappingContext } from '../../events/eventMappers';
import { generateMessageId } from '../../../shared/ids';
import { Logger } from '../../../shared/logger';
import type { RuntimeEvent } from '../../../contracts';

const logger = new Logger('ToolNode');

type SseSink = ((evt: unknown) => void) | undefined;

export interface ToolNodeEventBridgeDeps {
  sseSink: SseSink;
  conversationId: string;
  turnId: string;
  toolName: string;
  toolCallId: string | undefined;
  toolArgs: Record<string, unknown>;
  displayOptions: Record<string, unknown>;
  idempotencyKey?: string;
}

export class ToolNodeEventBridge {
  private readonly runtimeEvents: RuntimeEvent[] = [];
  private readonly deps: ToolNodeEventBridgeDeps;

  constructor(deps: ToolNodeEventBridgeDeps) {
    this.deps = deps;
  }

  emitToolProcess(
    phase: 'start' | 'update' | 'complete' | 'error',
    status: 'loading' | 'success' | 'error',
    payload: Record<string, unknown>
  ): RuntimeEvent | null {
    const id = generateMessageId();
    const timestamp = Date.now();
    const agentEvent: AgentToolProcessEvent = {
      type: 'tool_process',
      id,
      timestamp,
      tool_name: this.deps.toolName,
      tool_args: this.readToolArgs(payload),
      ...(Array.isArray(payload.tool_calls) ? { tool_calls: payload.tool_calls } : {}),
      tool_call_id: this.deps.toolCallId,
      phase,
      status,
      payload: { ...payload },
      meta: { displayOptions: this.deps.displayOptions },
    };

    logger.info('[ToolNode] 发出 tool_process 事件', {
      phase,
      status,
      toolName: this.deps.toolName,
      toolCallId: this.deps.toolCallId,
      eventId: id,
      conversationId: this.deps.conversationId,
      turnId: this.deps.turnId,
    });

    this.dispatchAgentEvent(agentEvent);
    return this.bufferRuntimeEvent(agentEvent, timestamp);
  }

  emitToolOutput(status: 'success' | 'error', payload: Record<string, unknown>): RuntimeEvent | null {
    const id = generateMessageId();
    const timestamp = Date.now();
    const output = payload.output;
    const agentEvent: AgentObservationEvent = {
      type: 'observation',
      id,
      timestamp,
      tool_name: this.deps.toolName,
      tool_call_id: this.deps.toolCallId,
      output: typeof output === 'string' ? output : this.serializeOutput(output),
      success: status === 'success',
      payload,
      duration_ms: payload.duration_ms as number | undefined,
    };

    logger.info('[ToolNode] 发出 tool_output 事件', {
      status,
      toolName: this.deps.toolName,
      toolCallId: this.deps.toolCallId,
      eventId: id,
      conversationId: this.deps.conversationId,
      turnId: this.deps.turnId,
    });

    this.dispatchAgentEvent(agentEvent);
    return this.bufferRuntimeEvent(agentEvent, timestamp);
  }

  emitFinalAnswer(params: { answer: string; sourceToolName: string }): RuntimeEvent | null {
    const id = generateMessageId();
    const timestamp = Date.now();
    const agentEvent = {
      type: 'final_answer' as const,
      id,
      timestamp,
      answer: params.answer,
      answer_id: `answer_${this.deps.toolCallId}`,
    };

    logger.info('[ToolNode] 工具输出映射为 final_answer', {
      sourceToolName: params.sourceToolName,
      toolCallId: this.deps.toolCallId,
      conversationId: this.deps.conversationId,
      turnId: this.deps.turnId,
      answerChars: params.answer.length,
    });

    this.dispatchAgentEvent(agentEvent);
    return this.bufferRuntimeEvent(agentEvent, timestamp);
  }

  getRuntimeEvents(): RuntimeEvent[] {
    return this.runtimeEvents;
  }

  private readToolArgs(payload: Record<string, unknown>): Record<string, unknown> {
    const maybeArgs = payload.args;
    if (maybeArgs && typeof maybeArgs === 'object' && !Array.isArray(maybeArgs)) {
      return maybeArgs as Record<string, unknown>;
    }
    return this.deps.toolArgs;
  }

  private serializeOutput(output: unknown): string {
    try {
      return JSON.stringify(output ?? '');
    } catch {
      return String(output ?? '');
    }
  }

  private dispatchAgentEvent(evt: unknown): void {
    if (!this.deps.sseSink) {
      return;
    }

    try {
      if (evt && typeof evt === 'object') {
        Object.defineProperty(evt, '__dispatched_via_sse__', {
          value: true,
          enumerable: false,
          configurable: true,
        });
      }
      this.deps.sseSink(evt);
    } catch (error) {
      console.warn('[ToolNode] Agent event dispatch failed:', error);
    }
  }

  private bufferRuntimeEvent(evt: unknown, timestamp: number): RuntimeEvent | null {
    const runtime = eventMapper.agentToRuntime(evt as never, this.getMappingContext(timestamp), {
      skipIncomplete: false,
    });
    if (runtime) {
      this.runtimeEvents.push(runtime);
      return runtime;
    }
    return null;
  }

  private getMappingContext(timestamp: number): EventMappingContext {
    return {
      conversationId: this.deps.conversationId,
      turnId: this.deps.turnId,
      timestamp,
      metadata: this.deps.idempotencyKey ? { idempotency: { key: this.deps.idempotencyKey } } : undefined,
    };
  }
}
