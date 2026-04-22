/**
 * @file src/agent/context-manager/profiles/chat/tasks/base.ts
 * 
 * @brief 定义所有聊天任务处理器必须遵守的接口。
 * 
 * @description
 * 每个业务场景（如自动补全、批注、标准聊天）都应实现此接口。
 * 这确保了 ChatService 可以用统一的方式调用它们。
 */

import type { GenerateRequest, ChatMessage } from '../contracts';

export interface IChatTask {
  /**
   * 根据前端请求构建发送给大模型的完整消息数组。
   * 
   * @param request 前端发来的生成请求
   * @returns 格式化后的 ChatMessage 数组
   */
  buildMessages(request: GenerateRequest): ChatMessage[];
  
  /**
   * (可选) 声明此任务是否应走“短链路”处理，
   * 即绕过复杂的上下文管理，直接将 buildMessages 的结果发送给 AI。
   * @default false
   */
  useSimpleProcessing?: boolean;

  /**
   * [新增] 声明此任务偏好使用的模型能力。
   * 如果设置了此项，并且用户没有在请求中明确指定 modelId，
   * ChatService会优先查找并使用具备该能力的模型。
   * @example 'fast_assistant'
   */
  preferredModelCapability?: string;

  /**
   * 对LLM返回的完整响应进行后处理。
   * @param rawResponse LLM返回的原始字符串
   * @returns 经过处理后的、适合返回给前端的文本
   * 
   * @description
   * 不同的任务场景对响应内容有不同的处理需求：
   * - 聊天/批注：保留 <think>...</think> 标签，让用户看到思考过程
   * - 自动补全：过滤掉所有思考内容，只返回干净的补全文本
   */
  processResponse(rawResponse: string): string;

  /**
   * 对流式生成的单个内容块进行处理。
   * 
   * @param chunk 流式生成的单个内容块
   * @returns 处理后的内容块，如果应该跳过则返回空字符串
   * 
   * @description
   * 用于流式生成场景，让每个任务决定是否要过滤某些流式块：
   * - 聊天/批注：直接返回原块，保留所有内容
   * - 自动补全：过滤掉包含 <think> 标签的块
   */
  processStreamChunk(chunk: string): string;
}

export type ChatTaskResolver = (promptKey?: string) => IChatTask;
