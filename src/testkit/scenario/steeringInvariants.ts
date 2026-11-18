import type { RuntimeEvent } from '../../contracts';
import type { ScriptedLlmCall } from '../agent-harness/scriptedInferenceHarness';
import { userInputText } from './timeline';

export type SteeringInvariantId =
  | 'S1_STEER_UNIQUE'
  | 'S2_STEER_AT_BATCH_BOUNDARY'
  | 'S3_STEER_IN_NEXT_MODEL_CALL'
  | 'S4_STEER_ONCE_PER_MODEL_CALL'
  | 'S5_STEER_KEPT_IN_LATER_CALLS';

export interface SteeringInvariantFailure {
  readonly id: SteeringInvariantId;
  readonly message: string;
}

export interface SteeringInvariantContext {
  /** 会话的持久历史（按落盘顺序），可以跨多次运行。 */
  readonly history: readonly RuntimeEvent[];
  /** 同一会话里按时间顺序的全部模型调用。 */
  readonly modelCalls: readonly ScriptedLlmCall[];
}

export interface ValidateSteeringInvariantsOptions {
  disabled?: readonly SteeringInvariantId[];
}

type UserInput = Extract<RuntimeEvent, { type: 'user_input' }>;

function isSteer(event: RuntimeEvent): event is UserInput {
  return event.type === 'user_input' && event.delivery === 'mid_run';
}

function messageIndexOfText(call: ScriptedLlmCall, text: string): number[] {
  return call.messages.flatMap((message, index) => {
    if (message.role !== 'user') return [];
    const body = message.content.map(block => (block.type === 'text' ? block.text : '')).join('');
    return body.includes(text) ? [index] : [];
  });
}

function toolMessageIndex(call: ScriptedLlmCall, toolCallId: string): number {
  return call.messages.findIndex(message => message.role === 'tool' && message.tool_call_id === toolCallId);
}

/**
 * 运行中插话的不变量。按“模型实际收到的消息”判断，而不是按实现细节判断：
 *
 * - S1 每条插话在历史里只出现一次；
 * - S2 只在一批工具全部结算后送达：插话之前已决定的每个工具调用都已有结果；
 * - S3 送达后的下一次模型调用（第一次带上前一批工具结果的调用）里就能看到它，并排在那批结果之后；
 * - S4 任何一次模型调用里，同一条插话最多出现在一条用户消息中；
 * - S5 一旦被模型看到，之后的每次调用都还带着它（当前实现保护本轮插话不被压缩）。
 *
 * 插话按原文子串匹配，Host 给正文包一层上下文（例如本地时间）不影响判断。
 */
export function validateSteeringInvariants(
  context: SteeringInvariantContext,
  options: ValidateSteeringInvariantsOptions = {},
): SteeringInvariantFailure[] {
  const disabled = new Set(options.disabled ?? []);
  const failures: SteeringInvariantFailure[] = [];
  const fail = (id: SteeringInvariantId, message: string) => {
    if (!disabled.has(id)) failures.push({ id, message });
  };
  const { history, modelCalls } = context;
  const steers = history.filter(isSteer);

  const seen = new Map<string, number>();
  for (const steer of steers) seen.set(steer.id, (seen.get(steer.id) ?? 0) + 1);
  for (const [id, count] of seen) {
    if (count > 1) fail('S1_STEER_UNIQUE', `插话 ${id} 在历史里出现了 ${count} 次`);
  }

  for (const steer of steers) {
    const text = userInputText(steer);
    const position = history.findIndex(event => event.id === steer.id);
    const before = history.slice(0, position);
    const decided = new Set<string>();
    const settled = new Set<string>();
    let lastToolOutputId: string | undefined;
    for (const event of before) {
      if (event.type === 'user_input' && event.delivery !== 'mid_run') {
        decided.clear();
        settled.clear();
        lastToolOutputId = undefined;
      }
      if (event.type === 'tool_call_decision') decided.add(event.tool_call_id);
      if (event.type === 'tool_output') {
        settled.add(event.tool_call_id);
        lastToolOutputId = event.tool_call_id;
      }
    }
    const unsettled = [...decided].filter(id => !settled.has(id));
    if (unsettled.length > 0 || lastToolOutputId === undefined) {
      fail('S2_STEER_AT_BATCH_BOUNDARY',
        `插话 ${steer.id} 没有排在一整批工具结果之后（未结算：${unsettled.join(', ') || '无工具结果'}）`);
      continue;
    }

    const nextCallIndex = modelCalls.findIndex(call => toolMessageIndex(call, lastToolOutputId) >= 0);
    if (nextCallIndex < 0) {
      fail('S3_STEER_IN_NEXT_MODEL_CALL', `插话 ${steer.id} 送达后再没有模型调用带上前一批工具结果`);
      continue;
    }
    const nextCall = modelCalls[nextCallIndex];
    const at = messageIndexOfText(nextCall, text);
    const toolAt = toolMessageIndex(nextCall, lastToolOutputId);
    if (at.length === 0) {
      fail('S3_STEER_IN_NEXT_MODEL_CALL', `第 ${nextCallIndex + 1} 次模型调用没有收到插话 ${steer.id}`);
    } else if (at[0] < toolAt) {
      fail('S3_STEER_IN_NEXT_MODEL_CALL', `第 ${nextCallIndex + 1} 次模型调用里插话 ${steer.id} 排在工具结果之前`);
    }

    for (const [index, call] of modelCalls.entries()) {
      const hits = messageIndexOfText(call, text).length;
      if (hits > 1) {
        fail('S4_STEER_ONCE_PER_MODEL_CALL', `第 ${index + 1} 次模型调用里插话 ${steer.id} 出现了 ${hits} 次`);
      }
      if (index > nextCallIndex && hits === 0) {
        fail('S5_STEER_KEPT_IN_LATER_CALLS', `第 ${index + 1} 次模型调用丢了插话 ${steer.id}`);
      }
    }
  }
  return failures;
}

export function assertSteeringInvariants(
  context: SteeringInvariantContext,
  options: ValidateSteeringInvariantsOptions = {},
): void {
  const failures = validateSteeringInvariants(context, options);
  if (failures.length > 0) {
    throw new Error(`[steeringInvariants] ${failures.map(f => `${f.id}: ${f.message}`).join('\n')}`);
  }
}
