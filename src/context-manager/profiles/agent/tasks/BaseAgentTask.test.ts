import { describe, expect, it } from 'vitest';
import type { AgentProfileRequest } from '../contracts';
import { BaseAgentTask } from './BaseAgentTask';
import { createAssistantMessage, createToolMessage, createUserMessage } from '../../../../contracts';
import type { AiMessage } from '../../../../contracts';

class TestAgentTask extends BaseAgentTask {
  readonly name = 'test-agent-task';

  protected getSystemPrompt(_request: AgentProfileRequest): string {
    return '你是测试 Agent。';
  }
}

describe('BaseAgentTask.buildMessages', () => {
  const task = new TestAgentTask();

  it('history 不含 user 时，应追加当前 query 作为 standalone user message', () => {
    const request: AgentProfileRequest = {
      query: '当前问题',
      promptKey: 'default',
    };

    const messages = task.buildMessages(request, []);

    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[1]).toMatchObject({
      role: 'user',
      type: 'user_input',
      content: '当前问题',
    });
  });

  it('history 已包含当前轮 user 时，不应重复追加 query，且应保持 history 时序', () => {
    const request: AgentProfileRequest = {
      query: '你是谁，你为什么叫demo-agent',
      promptKey: 'default',
    };
    const history: AiMessage[] = [
      createUserMessage('user_input', '你是谁，你为什么叫demo-agent'),
      createAssistantMessage('tool_calls', '我先调用工具。'),
      createToolMessage('搜索结果：demo-agent', 'call_search_1', 'web_search'),
    ];

    const messages = task.buildMessages(request, history);
    const matchedUsers = messages.filter((message) => {
      return (
        message.role === 'user' &&
        message.type === 'user_input' &&
        message.content === '你是谁，你为什么叫demo-agent'
      );
    });

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(matchedUsers).toHaveLength(1);
    expect(messages[messages.length - 1]).toMatchObject({
      role: 'tool',
      type: 'tool_output',
      content: '搜索结果：demo-agent',
    });
  });
});
