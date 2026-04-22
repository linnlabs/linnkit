/**
 * @file src/agent/context-manager/shared/preprocessors/__tests__/userQuoteLifetime.test.ts
 * @description 用户引用寿命预处理器测试
 * 
 * 运行测试:
 * npx tsx src/agent/context-manager/shared/preprocessors/__tests__/userQuoteLifetime.test.ts
 * 
 * 输入 (Input):
 * - 包含多个 user_input 的消息历史
 * - 其中部分消息带有 user_quote metadata
 * - 配置 keepLatestUserInputs = 2
 * 
 * 期望输出 (Expected Output):
 * - 最近 2 条 user_input 消息的引用被保留（如果 metadata 存在，则确保 content 中有 <user_quote>）
 * - 更早的 user_input 消息的引用被移除（content 中的 <user_quote> 块被删除，metadata 中的 user_quote 被移除）
 * - <user_query> 标签和内容被正确保留
 * 
 * 测试用例说明:
 * 1. 验证最近 N 条消息的引用是否被正确恢复
 * 2. 验证过期消息的引用是否被正确移除
 * 3. 验证无引用消息不受影响
 * 4. 验证边界情况（消息数少于 N 条）
 */

import { describe } from 'vitest';
describe.skip('TODO: 恢复历史测试（tsx-script 风格，未接入 vitest）', () => { /* see git history */ });

import { UserQuoteLifetimePreprocessor } from '../userQuoteLifetime';
import { AiMessage } from '../../../../contracts';

// Mock types for standalone testing
interface PreprocessorContext {
  debugMode?: boolean;
}

// Simple assertion helper
function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTest() {
  console.log('🧪 Starting UserQuoteLifetimePreprocessor Test...');
  
  const preprocessor = new UserQuoteLifetimePreprocessor({ keepLatestUserInputs: 2 });

  // Construct test messages
  // Msg 1: Old message with quote (should be stripped)
  const user1: AiMessage = {
    id: 'msg-1',
    role: 'user',
    type: 'user_input',
    content: '<user_quote>Old Quote</user_quote>\n<user_query>Old Query</user_query>',
    metadata: {
      user_quote: { text: 'Old Quote' }
    },
    timestamp: 1000
  };

  const assistant1: AiMessage = {
    id: 'msg-2',
    role: 'assistant',
    type: 'final_answer',
    content: 'Response 1',
    timestamp: 2000
  };

  // Msg 2: Recent message 1 (should keep/restore quote)
  // Simulating a message that lost its quote in content but has metadata
  const user2: AiMessage = {
    id: 'msg-3',
    role: 'user',
    type: 'user_input',
    content: 'Recent Query 1', // Quote missing in content
    metadata: {
      user_quote: {
        text: 'Recent Quote 1',
        source: { doc_id: 'doc-1' }
      }
    },
    timestamp: 3000
  };

  const assistant2: AiMessage = {
    id: 'msg-4',
    role: 'assistant',
    type: 'final_answer',
    content: 'Response 2',
    timestamp: 4000
  };

  // Msg 3: Recent message 2 (latest) (should keep quote)
  const user3: AiMessage = {
    id: 'msg-5',
    role: 'user',
    type: 'user_input',
    content: '<user_quote>Recent Quote 2</user_quote>\n<user_query>Recent Query 2</user_query>',
    metadata: {
      user_quote: { text: 'Recent Quote 2' }
    },
    timestamp: 5000
  };

  const messages: AiMessage[] = [user1, assistant1, user2, assistant2, user3];

  console.log('📥 Input messages:', messages.length);

  const result = await preprocessor.process(messages, { debugMode: true });
  const processedMessages = result.messages;

  console.log('📤 Processed messages:', processedMessages.length);

  // Verification 1: Oldest user message (msg-1) should NOT have quote
  const pUser1 = processedMessages.find(m => m.id === 'msg-1');
  assert(!!pUser1, 'Msg 1 exists');
  assert(!pUser1?.content.includes('<user_quote>'), 'Msg 1 quote stripped from content');
  assert(!pUser1?.metadata?.user_quote, 'Msg 1 quote stripped from metadata');
  console.log('✅ Test Case 1 Passed: Old quote stripped');

  // Verification 2: Recent user message 1 (msg-3) SHOULD have quote restored
  const pUser2 = processedMessages.find(m => m.id === 'msg-3');
  assert(!!pUser2, 'Msg 3 exists');
  assert(!!pUser2?.content.includes('<user_quote source_doc="doc-1">'), 'Msg 3 quote restored in content with attributes');
  assert(!!pUser2?.content.includes('Recent Quote 1'), 'Msg 3 quote text correct');
  console.log('✅ Test Case 2 Passed: Recent quote restored');

  // Verification 3: Latest user message (msg-5) SHOULD keep quote
  const pUser3 = processedMessages.find(m => m.id === 'msg-5');
  assert(!!pUser3, 'Msg 5 exists');
  assert(!!pUser3?.content.includes('<user_quote>'), 'Msg 5 quote preserved');
  console.log('✅ Test Case 3 Passed: Latest quote preserved');

  console.log('🎉 All tests passed!');
}

// vitest 加载本文件时跳过自调用；npx tsx <file> 直跑时仍执行
if (!process.env.VITEST) {
  runTest().catch(console.error);
}
