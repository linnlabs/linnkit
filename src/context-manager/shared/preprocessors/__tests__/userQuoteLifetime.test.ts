import { describe, expect, it } from 'vitest';

import type { AiMessage } from '../../../../contracts';
import { UserQuoteLifetimePreprocessor } from '../userQuoteLifetime';

function createUserInput(opts: {
  id: string;
  timestamp: number;
  content: string;
  quoteText?: string;
  source?: Record<string, unknown>;
}): AiMessage {
  return {
    id: opts.id,
    role: 'user',
    type: 'user_input',
    content: opts.content,
    timestamp: opts.timestamp,
    ...(opts.quoteText
      ? {
          metadata: {
            user_quote: {
              text: opts.quoteText,
              ...(opts.source ? { source: opts.source } : {}),
            },
          },
        }
      : {}),
  };
}

function createAssistant(id: string, timestamp: number, content: string): AiMessage {
  return {
    id,
    role: 'assistant',
    type: 'final_answer',
    content,
    timestamp,
  };
}

function getMessage(messages: AiMessage[], id: string): AiMessage {
  const message = messages.find((candidate) => candidate.id === id);
  if (!message) {
    throw new Error(`Message ${id} not found`);
  }
  return message;
}

describe('UserQuoteLifetimePreprocessor', () => {
  it('strips quotes from expired user inputs and restores them for the latest kept window', async () => {
    const preprocessor = new UserQuoteLifetimePreprocessor({ keepLatestUserInputs: 2 });

    const messages: AiMessage[] = [
      {
        id: 'msg-1',
        role: 'user',
        type: 'user_input',
        content: '<user_quote>Old Quote</user_quote>\n<user_query>Old Query</user_query>',
        metadata: {
          user_quote: { text: 'Old Quote' },
        },
        timestamp: 1000,
      },
      createAssistant('msg-2', 2000, 'Response 1'),
      createUserInput({
        id: 'msg-3',
        timestamp: 3000,
        content: 'Recent Query 1',
        quoteText: 'Recent Quote 1',
        source: { doc_id: 'doc-1' },
      }),
      createAssistant('msg-4', 4000, 'Response 2'),
      {
        id: 'msg-5',
        role: 'user',
        type: 'user_input',
        content: '<user_quote>Recent Quote 2</user_quote>\n<user_query>Recent Query 2</user_query>',
        metadata: {
          user_quote: { text: 'Recent Quote 2' },
        },
        timestamp: 5000,
      },
    ];

    const result = await preprocessor.process(messages, { debugMode: false });

    const oldUser = getMessage(result.messages, 'msg-1');
    expect(oldUser.content).not.toContain('<user_quote>');
    expect(oldUser.metadata?.user_quote).toBeUndefined();

    const restoredUser = getMessage(result.messages, 'msg-3');
    expect(restoredUser.content).toContain('<user_quote source_doc="doc-1">');
    expect(restoredUser.content).toContain('Recent Quote 1');
    expect(restoredUser.content).toContain('<user_query>');
    expect(result.appliedStrategies).toContain('user_quote_lifetime');

    const latestUser = getMessage(result.messages, 'msg-5');
    expect(latestUser.content).toContain('<user_quote>');
    expect(latestUser.content).toContain('Recent Quote 2');
  });

  it('preserves quote semantics across a long conversation after a history summary boundary', async () => {
    const preprocessor = new UserQuoteLifetimePreprocessor({ keepLatestUserInputs: 2 });

    const messages: AiMessage[] = [
      {
        id: 'user-old',
        role: 'user',
        type: 'user_input',
        content: '<user_quote>Legacy Quote</user_quote>\n<user_query>Legacy Query</user_query>',
        metadata: {
          user_quote: { text: 'Legacy Quote' },
        },
        timestamp: 1000,
      },
      createAssistant('assistant-old', 1500, '旧回答'),
      {
        id: 'summary-1',
        role: 'system',
        type: 'history_summary',
        content: '前面历史已摘要',
        metadata: {
          summarySeq: 1,
          replacedMessageIds: ['user-old', 'assistant-old'],
        },
        timestamp: 2000,
      },
      createUserInput({
        id: 'user-kept-1',
        timestamp: 3000,
        content: '摘要后的追问 1',
        quoteText: 'Recent Quote A',
        source: { doc_id: 'doc-a', start: 3, end: 8 },
      }),
      createAssistant('assistant-1', 3500, '回答 1'),
      createUserInput({
        id: 'user-kept-2',
        timestamp: 4000,
        content: '摘要后的追问 2',
        quoteText: 'Recent Quote B',
      }),
    ];

    const result = await preprocessor.process(messages, { debugMode: false });

    const oldUser = getMessage(result.messages, 'user-old');
    expect(oldUser.content).not.toContain('<user_quote>');
    expect(oldUser.content).toContain('<user_query>Legacy Query</user_query>');

    const keptAfterSummary = getMessage(result.messages, 'user-kept-1');
    expect(keptAfterSummary.content).toContain('<user_quote source_doc="doc-a" start="3" end="8">');
    expect(keptAfterSummary.content).toContain('Recent Quote A');
    expect(keptAfterSummary.content).toContain('<user_query>');
    expect(keptAfterSummary.content).toContain('摘要后的追问 1');

    const latestAfterSummary = getMessage(result.messages, 'user-kept-2');
    expect(latestAfterSummary.content).toContain('<user_quote>');
    expect(latestAfterSummary.content).toContain('Recent Quote B');

    expect(getMessage(result.messages, 'summary-1').content).toBe('前面历史已摘要');
  });

  it('leaves recent messages unchanged when they already contain quote blocks', async () => {
    const preprocessor = new UserQuoteLifetimePreprocessor({ keepLatestUserInputs: 2 });

    const messages: AiMessage[] = [
      createUserInput({
        id: 'user-1',
        timestamp: 1000,
        content: '无需引用',
      }),
      {
        id: 'user-2',
        role: 'user',
        type: 'user_input',
        content: '<user_quote>Kept Quote</user_quote>\n<user_query>Kept Query</user_query>',
        metadata: {
          user_quote: { text: 'Kept Quote' },
        },
        timestamp: 2000,
      },
      {
        id: 'user-3',
        role: 'user',
        type: 'user_input',
        content: '<user_quote>Latest Quote</user_quote>\n<user_query>Latest Query</user_query>',
        metadata: {
          user_quote: { text: 'Latest Quote' },
        },
        timestamp: 3000,
      },
    ];

    const result = await preprocessor.process(messages, { debugMode: false });

    expect(getMessage(result.messages, 'user-2').content).toBe(
      '<user_quote>Kept Quote</user_quote>\n<user_query>Kept Query</user_query>',
    );
    expect(getMessage(result.messages, 'user-3').content).toBe(
      '<user_quote>Latest Quote</user_quote>\n<user_query>Latest Query</user_query>',
    );
  });
});
