/**
 * @file src/agent/context-manager/profiles/agent/utils/__tests__/gemini-thought-signature.test.ts
 *
 * @description
 * Gemini 3 / 2.5 思考模型在工具调用轮次中会返回 thought_signature，并要求下一轮严格回传。
 * 本测试确保：
 * - RuntimeEvent(tool_call_decision).payload.tool_calls 中的 extra_content.google.thought_signature
 *   在 RuntimeEvent → AiMessage 回放时不会丢失
 * - 仅保证 RuntimeEvent(tool_call_decision) → AiMessage(tool_calls) 的回放不丢失 thought_signature
 * - 当前 convertAiMessageToEvent 不负责从 AiMessage(tool_calls) 重建 tool_call_decision
 */

import { describe, expect, it } from 'vitest';
import {
  convertAiMessageToEvent,
  convertEventToAiMessage,
} from '../eventConverter';
import type { RuntimeEvent, AiMessage } from '../../../../../contracts';

describe('Gemini thought_signature 透传', () => {
  it('RuntimeEvent(tool_call_decision) → AiMessage(tool_calls) 应保留 extra_content.google.thought_signature', () => {
    const runtime: RuntimeEvent = {
      type: 'tool_call_decision',
      id: 'evt_decision_1',
      conversation_id: 'c1',
      turn_id: 't1',
      timestamp: Date.now(),
      version: 1,
      tool_name: 'check_weather',
      tool_call_id: 'call_g1',
      phase: 'start',
      status: 'loading',
      args: { city: 'Paris' },
      payload: {
        tool_calls: [
          {
            id: 'call_g1',
            type: 'function',
            function: { name: 'check_weather', arguments: '{"city":"Paris"}' },
            extra_content: { google: { thought_signature: '<Signature_A>' } }
          }
        ]
      }
    };

    const msg = convertEventToAiMessage(runtime);
    expect(msg.role).toBe('assistant');
    expect(msg.type).toBe('tool_calls');
    expect(Array.isArray(msg.metadata?.tool_calls)).toBe(true);
    expect(msg.metadata?.tool_calls?.[0]?.id).toBe('call_g1');
    expect(msg.metadata?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe('<Signature_A>');
  });

  it('AiMessage(tool_calls) 反向转换不会重建 tool_call_decision，而是退化为 final_answer', () => {
    const ai: AiMessage = {
      id: 'msg_tc_1',
      role: 'assistant',
      type: 'tool_calls',
      content: '',
      timestamp: Date.now(),
      metadata: {
        tool_calls: [
          {
            id: 'call_g2',
            type: 'function',
            function: { name: 'book_taxi', arguments: '{"time":"10:00"}' },
            extra_content: { google: { thought_signature: '<Signature_B>' } }
          }
        ]
      }
    };

    const runtime = convertAiMessageToEvent(ai, {
      conversation_id: 'c2',
      turn_id: 't2',
    });
    expect(runtime.type).toBe('final_answer');
    if (runtime.type !== 'final_answer') {
      throw new Error('expected final_answer event');
    }
    expect(runtime.content).toBe('');
  });
});
