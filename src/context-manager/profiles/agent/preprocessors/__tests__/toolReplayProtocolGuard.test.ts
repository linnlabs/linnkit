import { describe, expect, it } from 'vitest';

import type { AiMessage } from '../../../../../contracts';
import { formatAgentLlmMessages } from '../../../../shared';
import { ToolReplayProtocolGuardPreprocessor } from '../toolReplayProtocolGuard';

const deepseekPolicy = {
  provider: 'deepseek',
  requiresReasoningDetailsForToolReplay: true,
  missingSidecarBehavior: 'degrade_to_text' as const,
};

const deepseekEmptyFallbackPolicy = {
  provider: 'deepseek',
  requiresReasoningDetailsForToolReplay: true,
  missingSidecarBehavior: 'provider_empty_replay_field' as const,
};

function userMessage(id: string, timestamp: number): AiMessage {
  return {
    id,
    role: 'user',
    type: 'user_input',
    content: id,
    timestamp,
  };
}

function toolCallsMessage(opts: {
  id: string;
  timestamp: number;
  reasoningDetails?: unknown[];
}): AiMessage {
  return {
    id: opts.id,
    role: 'assistant',
    type: 'tool_calls',
    content: '',
    timestamp: opts.timestamp,
    metadata: {
      ...(opts.reasoningDetails ? { reasoning_details: opts.reasoningDetails } : {}),
      tool_calls: [
        {
          id: `${opts.id}_call`,
          type: 'function',
          function: {
            name: 'workspace_read',
            arguments: JSON.stringify({ path: 'README.md' }),
          },
        },
      ],
    },
  };
}

function toolOutputMessage(toolCallSourceId: string, timestamp: number): AiMessage {
  return {
    id: `${toolCallSourceId}_output`,
    role: 'tool',
    type: 'tool_output',
    content: '{"observation":"README 内容"}',
    timestamp,
    metadata: {
      tool_call_id: `${toolCallSourceId}_call`,
      tool_name: 'workspace_read',
      raw_output: '{"observation":"README 内容"}',
    },
  };
}

describe('ToolReplayProtocolGuardPreprocessor', () => {
  it('降级历史轮次中缺少 required reasoning_details 的完整工具组', async () => {
    const preprocessor = new ToolReplayProtocolGuardPreprocessor({ policy: deepseekPolicy });
    const result = await preprocessor.process(
      [
        userMessage('user_old', 1000),
        toolCallsMessage({ id: 'assistant_missing_sidecar', timestamp: 1100 }),
        toolOutputMessage('assistant_missing_sidecar', 1200),
        userMessage('user_followup', 2000),
      ],
      { debugMode: false },
    );

    expect(formatAgentLlmMessages(result.messages).some((message) => message.role === 'assistant' && 'tool_calls' in message)).toBe(false);
    expect(formatAgentLlmMessages(result.messages).some((message) => message.role === 'tool')).toBe(false);
    expect(result.messages.some((message) => message.metadata?.isDegradedToolReplay === true)).toBe(true);
    expect(result.appliedStrategies).toContain('tool_replay_protocol_guard');
  });

  it('保留带真实 reasoning_details 的历史工具组', async () => {
    const reasoningDetails = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Need README.' },
    ];
    const preprocessor = new ToolReplayProtocolGuardPreprocessor({ policy: deepseekPolicy });
    const result = await preprocessor.process(
      [
        userMessage('user_old', 1000),
        toolCallsMessage({ id: 'assistant_with_sidecar', timestamp: 1100, reasoningDetails }),
        toolOutputMessage('assistant_with_sidecar', 1200),
        userMessage('user_followup', 2000),
      ],
      { debugMode: false },
    );
    const assistant = formatAgentLlmMessages(result.messages).find((message) => {
      return message.role === 'assistant' && 'tool_calls' in message;
    });

    expect(assistant?.reasoning_details).toEqual(reasoningDetails);
    expect(result.appliedStrategies).not.toContain('tool_replay_protocol_guard');
  });

  it('不降级当前轮次工具组，避免掩盖新链路丢 sidecar 的根因', async () => {
    const preprocessor = new ToolReplayProtocolGuardPreprocessor({ policy: deepseekPolicy });
    const result = await preprocessor.process(
      [
        userMessage('user_current', 1000),
        toolCallsMessage({ id: 'assistant_current_missing_sidecar', timestamp: 1100 }),
        toolOutputMessage('assistant_current_missing_sidecar', 1200),
      ],
      { debugMode: false },
    );

    expect(formatAgentLlmMessages(result.messages).some((message) => message.role === 'assistant' && 'tool_calls' in message)).toBe(true);
    expect(result.messages.some((message) => message.metadata?.isDegradedToolReplay === true)).toBe(false);
  });

  it('可按 host 策略保留结构化工具回放，并标记由 provider 补空 replay 字段', async () => {
    const preprocessor = new ToolReplayProtocolGuardPreprocessor({ policy: deepseekEmptyFallbackPolicy });
    const result = await preprocessor.process(
      [
        userMessage('user_old', 1000),
        toolCallsMessage({ id: 'assistant_missing_sidecar', timestamp: 1100 }),
        toolOutputMessage('assistant_missing_sidecar', 1200),
        userMessage('user_followup', 2000),
      ],
      { debugMode: false },
    );

    const llmMessages = formatAgentLlmMessages(result.messages);
    const assistant = llmMessages.find((message) => message.role === 'assistant' && 'tool_calls' in message);

    expect(assistant).toBeDefined();
    expect(assistant?.provider_empty_replay_field).toBe(true);
    expect(llmMessages.some((message) => message.role === 'tool')).toBe(true);
    expect(result.messages.some((message) => message.metadata?.isDegradedToolReplay === true)).toBe(false);
    expect(result.appliedStrategies).toContain('tool_replay_protocol_guard');
  });
});
