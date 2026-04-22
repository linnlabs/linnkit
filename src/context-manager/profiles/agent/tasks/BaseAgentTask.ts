/**
 * @file src/agent/context-manager/profiles/agent/tasks/BaseAgentTask.ts
 * @description Agent任务的抽象基类 - 处理Agent通用逻辑
 *
 * 🔥 重构：借鉴 BaseConversationalTask 的轻量级设计
 * 专注于核心消息构建，将复杂的上下文管理交给 AgentContextManager
 */

import type { AgentProfileRequest } from '../contracts';
import { IAgentTask } from './base';
import { generateMessageId } from '../../../../shared/ids';
import type { AiMessage } from '../../../../contracts';

/**
 * Agent任务的抽象基类
 *
 * @abstract
 * @description
 * 现在只负责构建 Agent 任务的核心消息骨架：
 * - system prompt
 * - contextual user messages
 * - 当前 user query
 * - 按时序附加 history
 */
export abstract class BaseAgentTask implements IAgentTask {
  abstract readonly name: string;

  protected abstract getSystemPrompt(request: AgentProfileRequest): string;

  public getSystemPromptForRequest(request: AgentProfileRequest): string {
    return this.getSystemPrompt(request);
  }

  buildMessages(request: AgentProfileRequest, history: AiMessage[]): AiMessage[] {
    const messages: AiMessage[] = [];

    const systemPrompt = this.getSystemPrompt(request);
    if (systemPrompt && systemPrompt.trim()) {
      messages.push({
        id: generateMessageId(),
        role: 'system',
        type: 'system_prompt',
        content: systemPrompt,
        timestamp: Date.now(),
      });
    }

    this.addContextualUserMessages(request, messages);

    const hasUserMessageInHistory = history.some((m) => m.role === 'user');

    if (!hasUserMessageInHistory && request.query && request.query.trim()) {
      let userContent = request.query.trim();

      if (request.user_quote?.text) {
        const quote = request.user_quote;
        const attrs: string[] = [];
        const source = quote.source;
        const docId = source && typeof source['doc_id'] === 'string' ? source['doc_id'] : undefined;
        const blockId = source && typeof source['block_id'] === 'string' ? source['block_id'] : undefined;
        const start = source && typeof source['start'] === 'number' ? source['start'] : undefined;
        const end = source && typeof source['end'] === 'number' ? source['end'] : undefined;

        if (docId) attrs.push(`source_doc="${docId}"`);
        if (blockId) attrs.push(`block_id="${blockId}"`);
        if (start !== undefined) attrs.push(`start="${start}"`);
        if (end !== undefined) attrs.push(`end="${end}"`);

        const openTag = attrs.length > 0 ? `<user_quote ${attrs.join(' ')}>` : '<user_quote>';
        const quoteBlock = `${openTag}\n${quote.text.trim()}\n</user_quote>`;
        const queryBlock = `<user_query>\n${userContent}\n</user_query>`;
        userContent = `${quoteBlock}\n${queryBlock}`;
      }

      messages.push({
        id: generateMessageId(),
        role: 'user',
        type: 'user_input',
        content: userContent,
        timestamp: Date.now(),
      });
    }

    messages.push(...history);

    return messages;
  }

  private addContextualUserMessages(request: AgentProfileRequest, messages: AiMessage[]): void {
    if (request.context_before?.trim()) {
      messages.push({
        id: generateMessageId(),
        role: 'user',
        type: 'context_before',
        content: `[前置上下文]\n${request.context_before.trim()}`,
        timestamp: Date.now(),
        metadata: {
          contextType: 'context_before',
          fragmentType: 'document',
        },
      });
    }

    const supplementalSections: string[] = [];
    const projectName = request.project_metadata?.name?.trim();
    const projectDescription = request.project_metadata?.description?.trim();
    const documentTitle = request.document_title?.trim();
    const documentFragment = request.document_fragment?.trim();
    const injectedContext = request.injected_context?.trim();

    if (projectName || projectDescription) {
      const projectLines: string[] = [];
      if (projectName) projectLines.push(`project name: ${projectName}`);
      if (projectDescription) projectLines.push(`project description: ${projectDescription}`);
      supplementalSections.push(`<project_context>\n${projectLines.join('\n')}\n</project_context>`);
    }

    if (documentTitle || documentFragment) {
      const documentLines: string[] = [];
      if (documentTitle) documentLines.push(`document title: ${documentTitle}`);
      if (documentFragment) {
        documentLines.push('document fragment:');
        documentLines.push(documentFragment);
      }
      supplementalSections.push(`<document_context>\n${documentLines.join('\n')}\n</document_context>`);
    }

    if (injectedContext) {
      supplementalSections.push(injectedContext);
    }

    if (supplementalSections.length > 0) {
      messages.push({
        id: generateMessageId(),
        role: 'user',
        type: 'document_fragment',
        content: supplementalSections.join('\n\n'),
        timestamp: Date.now(),
      });
    }

    if (request.context_after?.trim()) {
      messages.push({
        id: generateMessageId(),
        role: 'user',
        type: 'context_after',
        content: `[后置上下文]\n${request.context_after.trim()}`,
        timestamp: Date.now(),
        metadata: {
          contextType: 'context_after',
          fragmentType: 'document',
        },
      });
    }
  }

  processResponse(rawResponse: string): string {
    return rawResponse;
  }

  processStreamChunk(chunk: string): string {
    return chunk;
  }
}
