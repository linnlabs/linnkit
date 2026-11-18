import type { RuntimeEvent } from '../../contracts';
import type { ScriptedLlmCall } from '../agent-harness/scriptedInferenceHarness';

export interface TimelineOptions {
  /** 文本截断长度，默认 40。 */
  maxText?: number;
  /** 只保留这些类型；默认保留全部可持久化的业务事实，去掉 metrics / usage / audit。 */
  types?: readonly RuntimeEvent['type'][];
}

const DEFAULT_HIDDEN: ReadonlySet<string> = new Set([
  'run_execution_metrics',
  'context_usage_snapshot',
  'audit_envelope',
  'tool_process',
  'final_answer_chunk',
  'final_answer_reset',
]);

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}…` : flat);
}

/** 插话（运行中送达的用户输入）的原文：Host 可能把正文包了一层上下文，原文在 raw_content。 */
export function userInputText(event: Extract<RuntimeEvent, { type: 'user_input' }>): string {
  return event.raw_content ?? event.content;
}

function describe(event: RuntimeEvent, max: number): string {
  switch (event.type) {
    case 'user_input':
      return `${event.delivery === 'mid_run' ? 'steer' : 'user'} ${clip(userInputText(event), max)}`;
    case 'thought':
      return `thought ${clip(event.content, max)}`;
    case 'tool_call_decision':
      return `call ${event.tool_name}#${event.tool_call_id}`;
    case 'tool_output':
      return `result ${event.tool_name}#${event.tool_call_id} ${event.status} ${clip(event.observation ?? '', max)}`;
    case 'final_answer':
      return `answer ${clip(event.content, max)}${event.completion_reason && event.completion_reason !== 'terminal' ? ` (${event.completion_reason})` : ''}`;
    case 'error':
      return `error ${event.error_code ?? ''} ${clip(event.error, max)}`.replace('  ', ' ');
    case 'requires_user_interaction':
      return `wait_user ${event.interaction_status}`;
    case 'llm_retry':
      return 'llm_retry';
    default:
      return event.type;
  }
}

/**
 * 把一串 RuntimeEvent 写成可读的时间线，一行一个事实。
 *
 * 用于断言整体顺序（`expect(timeline).toEqual([...])`）和失败时打印现场；
 * 不比较时间戳、序号等每次运行都会变的字段。
 */
export function formatRuntimeTimeline(
  events: readonly RuntimeEvent[],
  options: TimelineOptions = {},
): string[] {
  const max = options.maxText ?? 40;
  const keep = options.types ? new Set<string>(options.types) : undefined;
  return events
    .filter(event => (keep ? keep.has(event.type) : !DEFAULT_HIDDEN.has(event.type)))
    .filter(event => !(event.type === 'thought' && event.ephemeral))
    .map(event => describe(event, max));
}

function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.map(block => (block.type === 'text' ? block.text ?? '' : `[${block.type}]`)).join('');
}

/** 一次模型调用收到的消息，一行一条：`system` / `user "…"` / `assistant call search` / `tool #id "…"`。 */
export function formatModelMessages(call: ScriptedLlmCall, options: { maxText?: number } = {}): string[] {
  const max = options.maxText ?? 40;
  return call.messages.map(message => {
    switch (message.role) {
      case 'system':
        return 'system';
      case 'user':
        return `user ${clip(textOf(message.content), max)}`;
      case 'tool':
        return `tool #${message.tool_call_id} ${clip(textOf(message.content), max)}`;
      case 'assistant': {
        const parts = message.parts.map(part => {
          if (part.type === 'text') return clip(part.text, max);
          if (part.type === 'tool_call') return `call ${part.call.name}#${part.call.id}`;
          return 'reasoning';
        });
        return `assistant ${parts.join(' ')}`;
      }
    }
  });
}
