/**
 * @file src/agent/context-manager/profiles/chat/tasks/BaseConversationalTask.ts
 * 
 * @brief 对话型任务的抽象基类 - 处理多轮对话场景的通用逻辑
 * 
 * @description
 * BaseConversationalTask 是所有需要处理对话历史的任务的抽象基类。
 * 
 * 🔥 设计理念（参考 BaseAgentTask）：
 * - Task层：构建核心的、必须的消息（系统提示词 + 文档上下文 + 当前用户输入）
 * - ContextManager层：处理复杂的上下文管理、历史编排、Token优化
 * 
 * 它封装了对话型任务的标准流程：
 * 1. 添加系统提示词（由子类实现）
 * 2. 添加文档上下文（如果提供）
 * 3. 添加当前用户输入（如果历史中没有用户消息）
 * 4. 附加完整的对话历史（不做任何过滤，保留所有消息包括 history_summary）
 * 
 * 与工具型任务的区别：
 * - 工具型任务：使用 useSimpleProcessing=true，不处理对话历史，专注于单次请求
 * - 对话型任务：处理完整的对话上下文，支持多轮对话
 */

import type { GenerateRequest, ChatMessage } from '../contracts';
import { IChatTask } from './base';

/**
 * 对话型任务的抽象基类
 * 
 * @abstract
 * @description
 * 🔥 参考 BaseAgentTask 的轻量级设计，专注于核心消息构建
 * 
 * 所有需要处理对话历史的任务都应该继承此类。
 * 该基类实现了标准的对话上下文构建流程，子类只需要实现系统提示词的获取。
 * 
 * 重要特性：
 * - 不过滤任何历史消息，完整保留对话历史（包括 history_summary）
 * - 复杂的上下文管理由 ContextManager 层处理
 */
export abstract class BaseConversationalTask implements IChatTask {
  /**
   * 对话型任务默认使用完整处理链路（MessageOrchestrator）
   */
  readonly useSimpleProcessing = false;

  /**
   * 抽象方法：子类必须实现此方法来提供特定的系统提示词
   * 
   * @abstract
   * @returns 系统提示词字符串
   */
  protected abstract getSystemPrompt(request: GenerateRequest): string;

  /**
   * 构建对话消息的标准流程
   * 
   * @description
   * 🔥 参考 BaseAgentTask 的实现，实现了所有对话型任务都需要的标准流程：
   * 1. 添加系统提示词 - Task层拥有对系统指令的完全控制权
   * 2. 添加文档片段（如果有）
   * 3. 添加当前用户输入（仅当历史中没有用户消息时）
   * 4. 附加完整的对话历史（不做任何过滤，保留所有消息包括 history_summary）
   * 
   * @param request 生成请求
   * @returns 构建好的消息数组
   */
  buildMessages(request: GenerateRequest): ChatMessage[] {
    const messages: ChatMessage[] = [];
    
    // 1. 添加系统提示词 - Task层拥有对系统指令的完全控制权
    const systemPrompt = this.getSystemPrompt(request);
    messages.push({
      role: 'system', 
      content: systemPrompt, 
      type: 'system_prompt'
    });

    // 2. 获取对话历史（不做任何过滤，完全参考 BaseAgentTask 的实现）
    const history: ChatMessage[] = request.conversationHistory || [];
    
    // 🔥 关键修复：检查历史中是否已包含用户消息（参考 BaseAgentTask 的逻辑）
    const hasUserMessageInHistory = history.some(m => m.role === 'user');
    
    // 3. 如果有文档片段，添加文档上下文
    const supplementalSections: string[] = [];
    const projectName = request.projectMetadata?.name?.trim();
    const projectDescription = request.projectMetadata?.description?.trim();
    const documentTitle = request.documentMetadata?.title?.trim();

    if (projectName || projectDescription) {
      const projectLines: string[] = [];
      if (projectName) {
        projectLines.push(`project name: ${projectName}`);
      }
      if (projectDescription) {
        projectLines.push(`project description: ${projectDescription}`);
      }
      supplementalSections.push(`<project_context>\n${projectLines.join('\n')}\n</project_context>`);
    }

    if ((documentTitle || request.documentFragment?.trim())) {
      const documentLines: string[] = [];
      if (documentTitle) {
        documentLines.push(`document title: ${documentTitle}`);
      }
      if (request.documentFragment && request.documentFragment.trim()) {
        documentLines.push('document fragment:');
        documentLines.push(request.documentFragment.trim());
      }
      supplementalSections.push(`<document_context>\n${documentLines.join('\n')}\n</document_context>`);
    }

    if (supplementalSections.length > 0) {
      messages.push({
        role: 'user',
        content: supplementalSections.join('\n\n'),
        type: 'document_fragment'
      });
    }
    
    // 4. 🔥 只有在历史中没有用户消息时，才添加当前用户输入
    // 这避免了在重复调用时添加重复的用户输入
    if (!hasUserMessageInHistory) {
      messages.push({
        role: 'user', 
        content: request.prompt.trim(),
        type: 'user_input'
      });
    }
    
    // 5. 🔥 将完整的、时序正确的历史记录附加到新构建的消息后面（参考 BaseAgentTask）
    // 不做任何过滤，保留所有消息（包括 history_summary）
    // 如果存在 userQuote，则在附加前对“最后一条用户输入”进行内容重写：
    //   <user_quote ...>引用内容</user_quote>
    //   <user_query>用户问题</user_query>
    let finalHistory = history;

    if (request.userQuote && history.length > 0) {
      // 从后往前找到最后一条用户输入消息
      const lastUserIndex = [...history]
        .map((msg, idx) => ({ msg, idx }))
        .reverse()
        .find(entry => entry.msg.role === 'user' && (entry.msg.type === 'user_input' || !entry.msg.type))?.idx;

      if (lastUserIndex !== undefined) {
        const quote = request.userQuote;
        const source = (quote.source || {}) as Record<string, unknown>;
        const attrs: string[] = [];

        if (typeof source.doc_id === 'string') {
          attrs.push(`source_doc="${source.doc_id}"`);
        }
        if (typeof source.block_id === 'string') {
          attrs.push(`block_id="${source.block_id}"`);
        }
        if (typeof source.start === 'number') {
          attrs.push(`start="${source.start}"`);
        }
        if (typeof source.end === 'number') {
          attrs.push(`end="${source.end}"`);
        }

        const openTag = attrs.length > 0
          ? `<user_quote ${attrs.join(' ')}>`
          : '<user_quote>';

        const quoteText = quote.text.trim();
        const promptText = request.prompt.trim();

        const quoteBlock = `${openTag}\n${quoteText}\n</user_quote>`;
        const queryBlock = `<user_query>\n${promptText}\n</user_query>`;
        const combined = `${quoteBlock}\n${queryBlock}`;

        finalHistory = history.slice();
        finalHistory[lastUserIndex] = {
          ...finalHistory[lastUserIndex],
          content: combined,
        };
      }
    }

    messages.push(...finalHistory);
    
    return messages;
  }

  /**
   * 默认的响应处理 - 保留完整内容包括思考过程
   * 
   * @description
   * 对话型任务通常保留完整的响应内容，包括 <think> 标签，
   * 让用户看到AI的思考过程。子类可以覆盖此方法来实现特定的处理逻辑。
   * 
   * @param rawResponse LLM返回的原始响应
   * @returns 处理后的响应文本
   */
  processResponse(rawResponse: string): string {
    // 默认保留完整的响应内容，包括思考过程
    return rawResponse;
  }

  /**
   * 默认的流式块处理 - 直接返回原块
   * 
   * @description
   * 对话型任务通常直接返回原始流式块，保留所有内容包括思考过程。
   * 子类可以覆盖此方法来实现特定的处理逻辑。
   * 
   * @param chunk 流式内容块
   * @returns 处理后的内容块
   */
  processStreamChunk(chunk: string): string {
    // 默认直接返回原块，保留所有内容包括思考过程
    return chunk;
  }
}
