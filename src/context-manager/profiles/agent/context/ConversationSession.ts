import type { AiMessage, AssistantMessage } from '../../../../contracts';

/**
 * 对话会话管理类
 * 
 * 单一职责：管理当前会话的消息存储和基础CRUD操作
 * - 存储和检索消息
 * - 维护对话历史的完整性
 * - 提供基础的消息查询功能
 * 
 * 不负责：Token管理、智能截断、优先级分析（这些由WorkingContextManager处理）
 */
export class ConversationSession {
  private messages: AiMessage[];
  private systemPrompt: string;

  /**
   * 构造函数
   * @param systemPrompt 系统提示词
   */
  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
    this.messages = []; // 初始化为空数组
    
    // 🔥 核心修复：仅当systemPrompt有实际内容时才添加系统消息
    if (systemPrompt && systemPrompt.trim()) {
      this.messages.push({
        id: `system_${Date.now()}`,
        role: 'system',
        type: 'system_prompt',
        content: systemPrompt,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 添加消息到会话
   * @param role 消息角色
   * @param content 消息内容
   */
  addMessage(role: 'user' | 'assistant', content: string): void {
    if (role === 'user') {
      this.messages.push({
        id: `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        role: 'user',
        type: 'user_input',
        content,
        timestamp: Date.now()
      });
    } else {
      this.messages.push({
        id: `assistant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        role: 'assistant',
        type: 'final_answer',
        content,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 添加用户消息
   * @param content 用户消息内容
   * @param id 可选的消息ID，如果不提供则自动生成
   */
  addUserMessage(content: string, id?: string): void {
    this.messages.push({
      id: id || `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: 'user',
      type: 'user_input',
      content,
      timestamp: Date.now()
    });
  }

  /**
   * 添加助手消息，可能包含工具调用
   * @param content 文本内容（可选）
   * @param type 消息类型
   * @param metadata 消息元数据（可选）
   * @param id 可选的消息ID，如果不提供则自动生成
   */
  addAssistantMessage(
    content: string | null, 
    type: AssistantMessage['type'],
    metadata?: AiMessage['metadata'],
    id?: string
  ): void {
    const message: AiMessage = {
      id: id || `assistant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      type: type,
      content: content || '',
      timestamp: Date.now(),
      metadata
    };
    this.messages.push(message);
  }

  /**
   * 添加从历史记录加载的工具输出消息
   * @param content 消息内容
   * @param metadata 消息元数据
   */
  addToolOutputMessage(content: string, metadata: AiMessage['metadata']): void {
    const toolCallId = metadata?.tool_call_id;
    if (!toolCallId) {
      console.warn('[ConversationSession] Skipping tool output message without tool_call_id');
      return;
    }

    const message: AiMessage = {
      id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: 'tool',
      type: 'tool_output',
      content,
      timestamp: Date.now(),
      metadata,
    };
    this.messages.push(message);
  }

  /**
   * 添加工具调用的响应结果
   * @param toolCallId 工具调用的唯一ID
   * @param content 工具执行返回的结果（通常是字符串格式）
   * @param toolName 工具名称（可选）
   * @param id 可选的消息ID，如果不提供则自动生成
   */
  addToolResponse(toolCallId: string, content: string, toolName?: string, id?: string): void {
    this.messages.push({
      id: id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: 'tool',
      type: 'tool_output',
      // 🔥 新增：OpenAI 兼容字段 name，用于标识工具名
      ...(toolName ? { name: toolName } : {}),
      content,
      timestamp: Date.now(),
      metadata: {
        tool_call_id: toolCallId,
        tool_name: toolName
      }
    });
  }

  /**
   * 追加一条已构造完成的消息。
   *
   * 中文备注：
   * - 该方法用于回放阶段写入“已是最终形态”的消息，例如 `history_summary`；
   * - 这样 core 侧只依赖最小写入端口，不需要直接感知 `ConversationSession` 的私有字段结构。
   */
  appendMessage(message: AiMessage): void {
    this.messages.push(message);
  }

  /**
   * 获取完整的对话历史记录
   * @returns 消息数组
   */
  getHistory(): AiMessage[] {
    return [...this.messages]; // 返回副本，避免外部修改
  }

  /**
   * 清空对话历史，只保留系统提示词
   */
  clear(): void {
    this.messages = [
      {
        id: `system_${Date.now()}`,
        role: 'system',
        type: 'system_prompt',
        content: this.systemPrompt,
        timestamp: Date.now()
      }
    ];
  }

  /**
   * 更新系统提示词
   * @param newSystemPrompt 新的系统提示词
   */
  updateSystemPrompt(newSystemPrompt: string): void {
    this.systemPrompt = newSystemPrompt;
    
    // 更新历史记录中的系统消息
    if (this.messages.length > 0 && this.messages[0].role === 'system') {
      this.messages[0].content = newSystemPrompt;
    } else {
      // 如果第一条不是系统消息，则插入系统消息
      this.messages.unshift({
        id: `system_${Date.now()}`,
        role: 'system',
        type: 'system_prompt',
        content: newSystemPrompt,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 获取当前系统提示词
   * @returns 系统提示词字符串
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * 获取消息总数（不包括系统消息）
   * @returns 消息数量
   */
  getMessageCount(): number {
    return this.messages.filter(msg => msg.role !== 'system').length;
  }

  /**
   * 获取最近的n条用户消息
   * @param n 消息数量
   * @returns 用户消息数组
   */
  getRecentUserMessages(n: number): AiMessage[] {
    return this.messages
      .filter(msg => msg.role === 'user')
      .slice(-n);
  }

  /**
   * 获取最近的n条助手消息
   * @param n 消息数量  
   * @returns 助手消息数组
   */
  getRecentAssistantMessages(n: number): AiMessage[] {
    return this.messages
      .filter(msg => msg.role === 'assistant')
      .slice(-n);
  }

  /**
   * 检查是否有待处理的工具调用
   * @returns 是否有未响应的工具调用
   */
  hasPendingToolCalls(): boolean {
    // 从后往前查找最近的assistant消息
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      
      if (msg.role === 'assistant' && msg.metadata?.tool_calls && msg.metadata.tool_calls.length > 0) {
        // 检查这些工具调用是否都有对应的tool响应
        const toolCallIds = msg.metadata.tool_calls.map(tc => tc.id);
        const toolResponseIds = this.messages
          .slice(i + 1)
          .filter(m => m.role === 'tool')
          .map(m => m.metadata?.tool_call_id)
          .filter(id => id !== undefined);

        // 如果有工具调用ID没有对应的响应，说明有待处理的工具调用
        return !toolCallIds.every(id => toolResponseIds.includes(id));
      }
      
      // 如果遇到user消息，说明这一轮对话已结束
      if (msg.role === 'user') {
        break;
      }
    }
    
    return false;
  }

  /**
   * 获取待处理的工具调用
   * @returns 待处理的工具调用数组
   */
  getPendingToolCalls(): Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }> {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      
      if (msg.role === 'assistant' && msg.metadata?.tool_calls && msg.metadata.tool_calls.length > 0) {
        const toolCallIds = msg.metadata.tool_calls.map(tc => tc.id);
        const toolResponseIds = this.messages
          .slice(i + 1)
          .filter(m => m.role === 'tool')
          .map(m => m.metadata?.tool_call_id)
          .filter(id => id !== undefined);

        // 返回没有响应的工具调用
        return msg.metadata.tool_calls.filter(tc => !toolResponseIds.includes(tc.id));
      }
      
      if (msg.role === 'user') {
        break;
      }
    }
    
    return [];
  }

  /**
   * 将历史记录序列化为JSON
   * @returns JSON字符串
   */
  serialize(): string {
    return JSON.stringify({
      systemPrompt: this.systemPrompt,
      messages: this.messages
    });
  }

  /**
   * 从JSON反序列化历史记录
   * @param json JSON字符串
   * @returns ConversationSession实例
   */
  static deserialize(json: string): ConversationSession {
    const data = JSON.parse(json);
    const session = new ConversationSession(data.systemPrompt);
    // 兼容性处理：支持旧的数据格式
    const messages = data.messages || data.history || [];
    
    // 如果没有系统消息，就使用默认的系统消息
    if (messages.length === 0 || messages[0].role !== 'system') {
      session.messages = [
        {
          id: `system_${Date.now()}`,
          role: 'system',
          type: 'system_prompt',
          content: data.systemPrompt,
          timestamp: new Date()
        },
        ...messages
      ];
    } else {
      session.messages = messages;
    }
    
    return session;
  }
}

// 🔥 优化：移除别名，统一使用ConversationSession
// 如需向后兼容，可以在需要的地方单独导入
