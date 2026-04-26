import { describe, expect, it } from 'vitest';

import type { AiMessage, RuntimeEvent } from '../../../contracts';
import { applyRuntimeEventToMemory, type ConversationMemoryPort } from '../eventMappers';

class TestMemory implements ConversationMemoryPort {
  readonly messages: AiMessage[] = [];

  addUserMessage(content: string, id?: string): void {
    this.messages.push({
      id: id ?? 'user',
      role: 'user',
      type: 'user_input',
      content,
      timestamp: 1,
    });
  }

  addAssistantMessage(
    content: string | null,
    type: AiMessage['type'] & ('thought' | 'final_answer' | 'tool_calls'),
    metadata?: AiMessage['metadata'],
    id?: string,
  ): void {
    this.messages.push({
      id: id ?? 'assistant',
      role: 'assistant',
      type,
      content: content ?? '',
      timestamp: 1,
      metadata,
    });
  }

  addToolResponse(toolCallId: string, content: string, toolName?: string, id?: string): void {
    this.messages.push({
      id: id ?? 'tool',
      role: 'tool',
      type: 'tool_output',
      content,
      timestamp: 1,
      metadata: {
        tool_call_id: toolCallId,
        tool_name: toolName,
      },
    });
  }

  appendMessage(message: AiMessage): void {
    this.messages.push(message);
  }
}

describe('eventMappers.applyRuntimeEventToMemory', () => {
  it('重建 tool_call_decision 时应保留 payload.reasoning_details sidecar', () => {
    const memory = new TestMemory();
    const reasoningDetails = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Need the tool.' },
    ];
    const event: RuntimeEvent = {
      type: 'tool_call_decision',
      id: 'tool_decision_1',
      conversation_id: 'conv_1',
      turn_id: 'turn_1',
      timestamp: 1,
      version: 1,
      tool_name: 'workspace_read',
      tool_call_id: 'call_1',
      phase: 'start',
      status: 'loading',
      payload: {
        reasoning_details: reasoningDetails,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'workspace_read', arguments: '{}' } },
        ],
      },
    };

    applyRuntimeEventToMemory(event, memory);

    expect(memory.messages).toHaveLength(1);
    expect(memory.messages[0].metadata?.reasoning_details).toEqual(reasoningDetails);
  });
});
