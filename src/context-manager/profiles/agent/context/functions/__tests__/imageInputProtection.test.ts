import { describe, expect, it } from 'vitest';
import type { AiMessage, RuntimeResourceRef } from '../../../../../../contracts';
import { buildImageProtectedMessageRanges } from '../imageInputProtection';
import { ToolCallIdSchema } from '../../../../../../contracts';

const image: RuntimeResourceRef = {
  id: 'attachment-1',
  kind: 'image',
  resourceId: 'asset-1',
  mediaType: 'image/png',
  byteLength: 128,
  width: 16,
  height: 8,
  sha256: 'a'.repeat(64),
};

function userMessage(id: string, attachments?: RuntimeResourceRef[]): AiMessage {
  return {
    id,
    role: 'user',
    type: 'user_input',
    content: id,
    timestamp: 1,
    ...(attachments ? { attachments } : {}),
  };
}

function finalAnswer(id: string): AiMessage {
  return {
    id,
    role: 'assistant',
    type: 'final_answer',
    content: id,
    timestamp: 1,
  };
}

describe('buildImageProtectedMessageRanges', () => {
  it('含图 user_input 会保护完整会话轮次，不让摘要只替换图片前后的半轮消息', () => {
    const messages: AiMessage[] = [
      userMessage('user-old'),
      finalAnswer('answer-old'),
      userMessage('user-image', [image]),
      finalAnswer('answer-image'),
      userMessage('user-current'),
    ];

    expect(buildImageProtectedMessageRanges(messages)).toEqual([{ startIndex: 2, endIndex: 3 }]);
  });

  it('工具结果含图时会保护完整 tool_calls/tool_output 交互组', () => {
    const messages: AiMessage[] = [
      {
        id: 'tool-call',
        role: 'assistant',
        type: 'tool_calls',
        content: 'tool-call',
        timestamp: 1,
        metadata: {
          tool_calls: [
            {
              id: ToolCallIdSchema.parse('call-1'),
              type: 'function',
              function: { name: 'inspect_image', arguments: '{}' },
            },
          ],
        },
      },
      {
        id: 'tool-output',
        role: 'tool',
        type: 'tool_output',
        content: 'tool-output',
        timestamp: 1,
        attachments: [image],
        metadata: {
          tool_call_id: ToolCallIdSchema.parse('call-1'),
          tool_name: 'inspect_image',
          data: { inspected: true },
        },
      },
      finalAnswer('answer'),
    ];

    expect(buildImageProtectedMessageRanges(messages)).toEqual([{ startIndex: 0, endIndex: 1 }]);
  });
});
