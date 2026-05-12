import { describe, expect, it } from 'vitest';
import { defineContextPolicy, type AiMessage } from '../../../../../contracts';
import { AgentContextManager } from '../AgentContextManager';
import { ConversationSession } from '../ConversationSession';
import {
  AgentCoreContextProvider,
  ContextProviderRegistry,
} from '../providers';

function message(
  id: string,
  role: AiMessage['role'],
  type: AiMessage['type'],
  content: string,
  timestamp: number,
): AiMessage {
  return { id, role, type, content, timestamp };
}

function createManager(): AgentContextManager {
  const registry = new ContextProviderRegistry();
  registry.register(new AgentCoreContextProvider());
  return new AgentContextManager({
    debugMode: false,
    providerRegistry: registry,
  });
}

describe('AgentContextManager ContextTrace', () => {
  it('默认不产出 trace，避免观测信息无意膨胀', async () => {
    const manager = createManager();
    const result = await manager.buildContextFromPreprocessedMessages(
      { promptKey: 'default', query: '当前问题' },
      new ConversationSession(''),
      [
        message('system_1', 'system', 'system_prompt', '系统提示', 1),
        message('assistant_1', 'assistant', 'final_answer', '旧回答', 2),
        message('user_1', 'user', 'user_input', '当前问题', 3),
      ],
      1000,
    );

    expect(result.contextTrace).toBeUndefined();
  });

  it('开启后记录 effective policy、provider token delta 与 keep/drop 决策', async () => {
    const manager = createManager();
    const effectivePolicy = defineContextPolicy({
      contextTrace: {
        enabled: true,
        includeMessageIds: true,
        includeTokenBreakdown: true,
        maxTraceEvents: 20,
      },
    });

    const result = await manager.buildContextFromPreprocessedMessages(
      { promptKey: 'default', query: '当前问题' },
      new ConversationSession(''),
      [
        message('system_1', 'system', 'system_prompt', '系统提示', 1),
        message('assistant_1', 'assistant', 'final_answer', '旧回答', 2),
        message('user_1', 'user', 'user_input', '当前问题', 3),
      ],
      1000,
      undefined,
      undefined,
      undefined,
      {
        policy: effectivePolicy.contextTrace,
        effectiveContextPolicy: effectivePolicy,
      },
    );

    expect(result.contextTrace).toMatchObject({
      enabled: true,
      totalBudget: 1000,
      originalCount: 3,
      finalCount: 2,
      truncated: true,
      effectivePolicy,
    });

    expect(result.contextTrace?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'provider',
          providerName: 'AgentCoreContextProvider',
          skipped: false,
          beforeKeptCount: 0,
          afterKeptCount: 2,
        }),
        expect.objectContaining({
          kind: 'message-decision',
          messageId: 'system_1',
          action: 'keep_core',
          kept: true,
          reason: 'kept_by_CORE_CONTEXT',
        }),
        expect.objectContaining({
          kind: 'message-decision',
          messageId: 'assistant_1',
          action: 'skip',
          kept: false,
          reason: 'dropped_by_budget_or_priority',
        }),
      ]),
    );
  });

  it('尊重 includeMessageIds=false 与 maxTraceEvents 上限', async () => {
    const manager = createManager();
    const effectivePolicy = defineContextPolicy({
      contextTrace: {
        enabled: true,
        includeMessageIds: false,
        includeTokenBreakdown: false,
        maxTraceEvents: 2,
      },
    });

    const result = await manager.buildContextFromPreprocessedMessages(
      { promptKey: 'default', query: '当前问题' },
      new ConversationSession(''),
      [
        message('system_1', 'system', 'system_prompt', '系统提示', 1),
        message('assistant_1', 'assistant', 'final_answer', '旧回答', 2),
        message('user_1', 'user', 'user_input', '当前问题', 3),
      ],
      1000,
      undefined,
      undefined,
      undefined,
      {
        policy: effectivePolicy.contextTrace,
        effectiveContextPolicy: effectivePolicy,
      },
    );

    expect(result.contextTrace?.overflowed).toBe(true);
    expect(result.contextTrace?.events).toHaveLength(2);
    for (const event of result.contextTrace?.events ?? []) {
      if (event.kind === 'message-decision') {
        expect(event.messageId).toBeUndefined();
        expect(event.tokens).toBe(0);
      }
      if (event.kind === 'provider') {
        expect(event.beforeTokens).toBe(0);
        expect(event.afterTokens).toBe(0);
      }
    }
  });
});
