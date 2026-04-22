/**
 * @file summary-id-mapping.test.ts
 * @description 测试摘要ID字段映射是否正确
 * 
 * 🔥 新架构: 数据库使用 snake_case (replaced_message_ids, summary_seq)
 *           代码使用 camelCase (replacedMessageIds, summarySeq)
 *           验证 eventConverter 是否正确转换
 */

import { describe, it, expect } from 'vitest';
import { convertEventToChatMessage } from '../profiles/chat/utils/eventConverter';
import { convertEventToAiMessage } from '../profiles/agent/utils/eventConverter';
import type { RuntimeEvent } from '../../contracts';

describe('摘要ID字段映射测试', () => {
  
  it('应该正确将 RuntimeEvent 的 snake_case 字段转换为 AiMessage 的 camelCase 字段 (Agent)', () => {
    // 模拟从数据库读取的 RuntimeEvent (使用 snake_case)
    const runtimeEvent: RuntimeEvent = {
      id: 'summary-123',
      conversation_id: 'conv-1',
      turn_id: 'system',
      type: 'history_summary',
      timestamp: Date.now(),
      version: 1,
      content: '[历史对话摘要]\\n\\n摘要内容',
      original_message_count: 10,
      compression_ratio: 0.8,
      generated_by: 'AgentSummarizationProvider',
      included_old_summary: false,
      // 🔥 新架构：精确 ID 列表 + 序列号
      replaced_message_ids: ['msg-001', 'msg-002', 'msg-003', 'msg-004', 'msg-005', 'msg-006', 'msg-007', 'msg-008', 'msg-009', 'msg-010'],
      summary_seq: 1,
    } as RuntimeEvent;

    // 转换为 AiMessage
    const aiMessage = convertEventToAiMessage(runtimeEvent);

    // 验证转换结果
    expect(aiMessage.role).toBe('system');
    expect(aiMessage.type).toBe('history_summary');
    expect(aiMessage.metadata).toBeDefined();
    
    // ⭐ 关键验证: 精确 ID 列表应该正确转换
    expect(aiMessage.metadata?.replacedMessageIds).toEqual(['msg-001', 'msg-002', 'msg-003', 'msg-004', 'msg-005', 'msg-006', 'msg-007', 'msg-008', 'msg-009', 'msg-010']);
    expect(aiMessage.metadata?.summarySeq).toBe(1);
    
    // 确认其他元数据也正确转换
    expect(aiMessage.metadata?.originalMessageCount).toBe(10);
    expect(aiMessage.metadata?.includedOldSummary).toBe(false);
  });

  it('应该正确将 RuntimeEvent 的 snake_case 字段转换为 ChatMessage 的 camelCase 字段 (Chat)', () => {
    const runtimeEvent: RuntimeEvent = {
      id: 'summary-456',
      conversation_id: 'conv-2',
      turn_id: 'system',
      type: 'history_summary',
      timestamp: Date.now(),
      version: 1,
      content: '[历史对话摘要]\\n\\n摘要内容',
      original_message_count: 5,
      compression_ratio: 0.7,
      generated_by: 'SummarizationProvider',
      included_old_summary: true,
      // 🔥 新架构：精确 ID 列表 + 序列号
      replaced_message_ids: ['msg-100', 'msg-101', 'msg-102', 'msg-103', 'msg-104'],
      summary_seq: 2,
    } as RuntimeEvent;

    const chatMessage = convertEventToChatMessage(runtimeEvent);

    expect(chatMessage).toBeDefined();
    expect(chatMessage?.role).toBe('system');
    expect(chatMessage?.type).toBe('history_summary');
    expect(chatMessage?.metadata).toBeDefined();
    
    // ⭐ 验证字段转换
    expect(chatMessage?.metadata?.replacedMessageIds).toEqual(['msg-100', 'msg-101', 'msg-102', 'msg-103', 'msg-104']);
    expect(chatMessage?.metadata?.summarySeq).toBe(2);
    expect(chatMessage?.metadata?.originalMessageCount).toBe(5);
    expect(chatMessage?.metadata?.includedOldSummary).toBe(true);
  });

  it('应该处理缺少 replaced_message_ids 的摘要', () => {
    const oldSummaryEvent: RuntimeEvent = {
      id: 'old-summary',
      conversation_id: 'conv-3',
      turn_id: 'system',
      type: 'history_summary',
      timestamp: Date.now(),
      version: 1,
      content: '旧版摘要',
      original_message_count: 3,
    } as RuntimeEvent;

    const aiMessage = convertEventToAiMessage(oldSummaryEvent);

    expect(aiMessage.metadata).toBeDefined();
    // 没有 replaced_message_ids，应返回空数组
    expect(aiMessage.metadata?.replacedMessageIds).toEqual([]);
    expect(aiMessage.metadata?.summarySeq).toBeUndefined();
  });
});
