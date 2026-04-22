/**
 * @file src/agent/runtime-kernel/llm/__tests__/caller.test.ts
 * @description LlmCaller 单元测试
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LlmCaller } from '../caller';
import type { AnyAgentEvent } from '../../events/agentEvents';
import type { AgentAiEngine } from '../../../ports/ai-engine';
import type { ModelCatalogLike } from '../modelCatalog';
import type { AiMessage } from '../../../contracts';

const mockChatCompletion = vi.fn();
const mockChatCompletionStream = vi.fn();
const mockGetModelsByCapability = vi.fn();
const mockGetModelsByUIVisibility = vi.fn();
const mockGetModelById = vi.fn();

function createModelCatalog(): ModelCatalogLike {
  return {
    getModelById: mockGetModelById,
    getModelsByCapability: mockGetModelsByCapability,
    getModelsByUIVisibility: mockGetModelsByUIVisibility,
  };
}

describe('LlmCaller', () => {
  let llmCaller: LlmCaller;
  let aiEngine: AgentAiEngine;
  let modelCatalog: ModelCatalogLike;
  const testModelId = 'test-model';
  const testMessages: AiMessage[] = [
    { 
      role: 'user', 
      type: 'user_input',
      content: 'Hello',
      id: 'msg_test_1',
      timestamp: Date.now(),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    aiEngine = {
      chatCompletion: mockChatCompletion,
      chatCompletionStream: mockChatCompletionStream,
    };
    modelCatalog = createModelCatalog();
    llmCaller = new LlmCaller({ aiEngine, modelCatalog });
    
    // 默认 mock 行为
    mockGetModelsByUIVisibility.mockReturnValue([
      { id: 'default-model', name: 'Default Model' },
    ]);
    mockGetModelsByCapability.mockReturnValue([
      { id: 'default-model', name: 'Default Model' },
    ]);
    mockGetModelById.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('构造函数', () => {
    it('应该使用默认配置创建实例', () => {
      const caller = new LlmCaller({ aiEngine, modelCatalog });
      expect(caller).toBeDefined();
    });

    it('应该接受自定义重试配置', () => {
      const customConfig = {
        maxRetries: 5,
        enableEmptyResponseRetry: false,
        retryDelayMs: 2000,
      };
      const caller = new LlmCaller({ ...customConfig, aiEngine, modelCatalog });
      expect(caller).toBeDefined();
    });

    it('应该支持部分重试配置', () => {
      const partialConfig = {
        maxRetries: 10,
      };
      const caller = new LlmCaller({ ...partialConfig, aiEngine, modelCatalog });
      expect(caller).toBeDefined();
    });
  });

  describe('resolveModelId', () => {
    it('应该返回提供的 modelId', () => {
      const modelId = llmCaller.resolveModelId('custom-model');
      expect(modelId).toBe('custom-model');
    });

    it('应该在未提供 modelId 时返回默认模型', () => {
      mockGetModelsByUIVisibility.mockReturnValue([
        { id: 'default-chat-model', name: 'Default Chat Model' },
      ]);
      mockGetModelsByCapability.mockReturnValue([
        { id: 'default-chat-model', name: 'Default Chat Model' },
      ]);

      const modelId = llmCaller.resolveModelId();
      expect(modelId).toBe('default-chat-model');
    });

    it('应该在没有可用模型时抛出错误', () => {
      mockGetModelsByUIVisibility.mockReturnValue([]);
      mockGetModelsByCapability.mockReturnValue([]);

      expect(() => llmCaller.resolveModelId()).toThrow('没有可用的聊天模型');
    });
  });

  describe('call - 非流式调用', () => {
    it('应该成功调用 LLM', async () => {
      const mockResponse = 'Hello! How can I help you?';
      mockChatCompletion.mockResolvedValue(mockResponse);

      const result = await llmCaller.call(testModelId, testMessages);

      expect(result).toBe(mockResponse);
      expect(mockChatCompletion).toHaveBeenCalledWith(
        testModelId,
        testMessages,
        { signal: undefined }
      );
    });

    it('应该支持传递选项参数', async () => {
      const mockResponse = 'Response';
      mockChatCompletion.mockResolvedValue(mockResponse);

      const options = {
        temperature: 0.7,
        max_tokens: 1000,
        tools: [],
      };

      await llmCaller.call(testModelId, testMessages, options);

      expect(mockChatCompletion).toHaveBeenCalledWith(
        testModelId,
        testMessages,
        { ...options, signal: undefined }
      );
    });

    it('应该处理包含工具调用的响应', async () => {
      const mockResponse = {
        content: 'Let me help you with that.',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function' as const,
            function: {
              name: 'get_weather',
              arguments: '{"location":"Beijing"}',
            },
          },
        ],
      };
      mockChatCompletion.mockResolvedValue(mockResponse);

      const result = await llmCaller.call(testModelId, testMessages);

      expect(result).toEqual({
        content: 'Let me help you with that.',
        tool_calls: mockResponse.tool_calls,
      });
    });

    it('应该处理对象格式的响应', async () => {
      const mockResponse = {
        content: 'Response content',
      };
      mockChatCompletion.mockResolvedValue(mockResponse);

      const result = await llmCaller.call(testModelId, testMessages);

      expect(result).toEqual({
        content: 'Response content',
        reasoning_details: undefined,
      });
    });

    it('应该支持 AbortSignal', async () => {
      const mockResponse = 'Response';
      mockChatCompletion.mockResolvedValue(mockResponse);

      const abortController = new AbortController();
      await llmCaller.call(testModelId, testMessages, {}, abortController.signal);

      expect(mockChatCompletion).toHaveBeenCalledWith(
        testModelId,
        testMessages,
        { signal: abortController.signal }
      );
    });

    it('应该在调用失败时抛出错误', async () => {
      const mockError = new Error('API Error');
      mockChatCompletion.mockRejectedValue(mockError);

      await expect(llmCaller.call(testModelId, testMessages)).rejects.toThrow('API Error');
    });
  });

  describe('callStream - 流式调用', () => {
    it('应该成功进行流式调用', async () => {
      const mockResponse = 'Hello! How can I help you?';
      mockChatCompletionStream.mockImplementation(
        async (modelId: any, messages: any, options: any, onContent: any, onError: any, onFinish: any) => {
          onContent('Hello! ');
          onContent('How can ');
          onContent('I help you?');
        }
      );

      const events: AnyAgentEvent[] = [];
      const eventHandler = (event: AnyAgentEvent) => {
        events.push(event);
      };

      const result = await llmCaller.callStream(
        testModelId,
        testMessages,
        {},
        eventHandler
      );

      expect(result).toBe('Hello! How can I help you?');
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(e => e.type === 'stream_chunk')).toBe(true);
    });

    it('应该正确处理 thought 事件', async () => {
      mockChatCompletionStream.mockImplementation(
        async (modelId: any, messages: any, options: any, onContent: any, onError: any, onFinish: any, onThought: any) => {
          onThought('Let me think...');
          onContent('Here is the answer.');
        }
      );

      const events: AnyAgentEvent[] = [];
      const eventHandler = (event: AnyAgentEvent) => {
        events.push(event);
      };

      await llmCaller.callStream(
        testModelId,
        testMessages,
        {},
        eventHandler
      );

      const thoughtEvents = events.filter(e => e.type === 'thought');
      expect(thoughtEvents.length).toBeGreaterThan(0);
      expect(thoughtEvents[0]).toHaveProperty('content');
    });

    it('应该累积工具调用增量', async () => {
      mockChatCompletionStream.mockImplementation(
        async (modelId: any, messages: any, options: any, onContent: any) => {
          // 模拟流式工具调用
          onContent({
            tool_calls: [
              {
                index: 0,
                id: 'call_123',
                function: { name: 'get_weather' },
              },
            ],
          });
          
          onContent({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"location":' },
              },
            ],
          });
          
          onContent({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '"Beijing"}' },
              },
            ],
          });
        }
      );

      const events: AnyAgentEvent[] = [];
      const result = await llmCaller.callStream(
        testModelId,
        testMessages,
        {},
        (event) => events.push(event)
      );

      expect(typeof result).toBe('object');
      if (typeof result === 'object' && Array.isArray(result.tool_calls)) {
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls[0].id).toBe('call_123');
        expect(result.tool_calls[0].function.name).toBe('get_weather');
        expect(result.tool_calls[0].function.arguments).toBe('{"location":"Beijing"}');
      }
    });

    it('流式 tool_call arguments 若最终不是合法 JSON，不应返回半截 tool_calls', async () => {
      mockChatCompletionStream.mockImplementation(
        async (_modelId: unknown, _messages: unknown, _options: unknown, onContent: (content: unknown) => void) => {
          onContent({
            tool_calls: [
              {
                index: 0,
                id: 'call_broken',
                function: { name: 'ppt_codegen' },
              },
            ],
          });

          onContent({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"code":"const slide = createSlide();' },
              },
            ],
          });
        }
      );

      await expect(
        llmCaller.callStream(testModelId, testMessages, {}, vi.fn())
      ).rejects.toThrow(/Stream ended with invalid tool_call\.arguments/);
    });

    it('ppt_codegen 在流式调用时应尽早发出占位 tool_process', async () => {
      mockChatCompletionStream.mockImplementation(
        async (_modelId: unknown, _messages: unknown, _options: unknown, onContent: (content: unknown) => void) => {
          onContent({
            tool_calls: [
              {
                index: 0,
                id: 'call_ppt_codegen_1',
                function: { name: 'ppt_codegen' },
              },
            ],
          });

          onContent({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"code":"compose({})"}' },
              },
            ],
          });
        }
      );

      const events: AnyAgentEvent[] = [];
      await llmCaller.callStream(testModelId, testMessages, {}, (event) => events.push(event));

      const placeholderEvent = events.find((event) => {
        if (event.type !== 'tool_process') return false;
        return event.tool_name === 'ppt_codegen'
          && event.tool_call_id === 'call_ppt_codegen_1'
          && event.phase === 'start'
          && event.status === 'loading';
      });

      expect(placeholderEvent).toBeDefined();
    });

    it('ppt_plan 在流式调用时应尽早发出占位 tool_process', async () => {
      mockChatCompletionStream.mockImplementation(
        async (_modelId: unknown, _messages: unknown, _options: unknown, onContent: (content: unknown) => void) => {
          onContent({
            tool_calls: [
              {
                index: 0,
                id: 'call_ppt_plan_1',
                function: { name: 'ppt_plan' },
              },
            ],
          });

          onContent({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"title":"Deck","pages":[{"title":"封面","content":"一句话说明页面内容。"}]}' },
              },
            ],
          });
        }
      );

      const events: AnyAgentEvent[] = [];
      await llmCaller.callStream(testModelId, testMessages, {}, (event) => events.push(event));

      const placeholderEvent = events.find((event) => {
        if (event.type !== 'tool_process') return false;
        return event.tool_name === 'ppt_plan'
          && event.tool_call_id === 'call_ppt_plan_1'
          && event.phase === 'start'
          && event.status === 'loading';
      });

      expect(placeholderEvent).toBeDefined();
    });

    it('应该在流式工具调用中累积 Gemini thought_signature 并保留到最终 tool_calls', async () => {
      mockChatCompletionStream.mockImplementation(
        async (
          _modelId: unknown,
          _messages: unknown,
          _options: unknown,
          onContent: (c: unknown) => void
        ) => {
          // Gemini 兼容：signature 通常只出现在当前 step 的第一个 tool_call 上
          onContent({
            tool_calls: [
              {
                index: 0,
                id: 'call_gemini_1',
                function: { name: 'check_weather' },
                extra_content: { google: { thought_signature: '<Signature_A>' } }
              }
            ]
          });

          // 后续增量参数
          onContent({
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"city":"Paris"}' },
              },
            ],
          });
        }
      );

      const result = await llmCaller.callStream(
        testModelId,
        testMessages,
        {},
        vi.fn()
      );

      expect(typeof result).toBe('object');
      if (typeof result !== 'object' || !result || !('tool_calls' in result)) {
        throw new Error('预期返回对象包含 tool_calls');
      }

      const rawToolCalls = (result as { tool_calls: unknown }).tool_calls;
      expect(Array.isArray(rawToolCalls)).toBe(true);
      const toolCalls = rawToolCalls as unknown[];
      expect(toolCalls).toHaveLength(1);

      const first = toolCalls[0] as unknown;
      if (!first || typeof first !== 'object') {
        throw new Error('tool_calls[0] 不是对象');
      }

      const firstObj = first as Record<string, unknown>;
      expect(firstObj['id']).toBe('call_gemini_1');

      const fn = firstObj['function'];
      if (!fn || typeof fn !== 'object') {
        throw new Error('tool_calls[0].function 不是对象');
      }
      const fnObj = fn as Record<string, unknown>;
      expect(fnObj['name']).toBe('check_weather');
      expect(fnObj['arguments']).toBe('{"city":"Paris"}');

      const extra = firstObj['extra_content'];
      if (!extra || typeof extra !== 'object') {
        throw new Error('tool_calls[0].extra_content 不是对象');
      }
      const extraObj = extra as Record<string, unknown>;
      const google = extraObj['google'];
      if (!google || typeof google !== 'object') {
        throw new Error('tool_calls[0].extra_content.google 不是对象');
      }
      const googleObj = google as Record<string, unknown>;
      expect(googleObj['thought_signature']).toBe('<Signature_A>');
    });

    it('应该处理流式调用中的错误', async () => {
      const mockError = new Error('Stream error');
      mockChatCompletionStream.mockImplementation(
        async (modelId: any, messages: any, options: any, onContent: any, onError: any) => {
          onError(mockError);
        }
      );

      const events: AnyAgentEvent[] = [];
      
      await expect(
        llmCaller.callStream(testModelId, testMessages, {}, (event) => events.push(event))
      ).rejects.toThrow('Stream error');

      const errorEvents = events.filter(e => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    it('应该支持 AbortSignal 取消流式调用', async () => {
      mockChatCompletionStream.mockResolvedValue(undefined);

      const abortController = new AbortController();
      const eventHandler = vi.fn();

      await llmCaller.callStream(
        testModelId,
        testMessages,
        {},
        eventHandler,
        abortController.signal
      );

      expect(mockChatCompletionStream).toHaveBeenCalledWith(
        testModelId,
        testMessages,
        expect.objectContaining({ signal: abortController.signal }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.any(Function)
      );
    });

    it('应该过滤掉无效的工具调用', async () => {
      mockChatCompletionStream.mockImplementation(
        async (modelId: any, messages: any, options: any, onContent: any) => {
          onContent({
            tool_calls: [
              {
                index: 0,
                id: 'call_valid',
                function: { name: 'valid_tool', arguments: '{}' },
              },
              {
                index: 1,
                id: 'call_invalid',
                function: { name: '', arguments: '{}' }, // 无效：空名称
              },
            ],
          });
        }
      );

      const result = await llmCaller.callStream(
        testModelId,
        testMessages,
        {},
        vi.fn()
      );

      expect(typeof result).toBe('object');
      if (typeof result === 'object' && Array.isArray(result.tool_calls)) {
        expect(result.tool_calls).toHaveLength(1);
        expect(result.tool_calls[0].id).toBe('call_valid');
      }
    });
  });

  describe('callWithRetries - 带重试的调用', () => {
    it('应该在首次成功时不重试', async () => {
      const mockResponse = 'Success';
      mockChatCompletion.mockResolvedValue(mockResponse);

      const result = await llmCaller.callWithRetries(testModelId, testMessages);

      expect(result).toBe(mockResponse);
      expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    });

    it('应该在失败后重试', async () => {
      const llmCallerWithRetry = new LlmCaller({ maxRetries: 2, aiEngine, modelCatalog });
      
      mockChatCompletion
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('Success after retry');

      const result = await llmCallerWithRetry.callWithRetries(testModelId, testMessages);

      expect(result).toBe('Success after retry');
      expect(mockChatCompletion).toHaveBeenCalledTimes(2);
    });

    it('应该在达到最大重试次数后失败', async () => {
      const llmCallerWithRetry = new LlmCaller({ maxRetries: 2, retryDelayMs: 10, aiEngine, modelCatalog });
      
      // 使用网络错误，这样会重试
      const mockError = new Error('Network timeout');
      mockError.name = 'NetworkError';
      mockChatCompletion.mockRejectedValue(mockError);

      await expect(
        llmCallerWithRetry.callWithRetries(testModelId, testMessages)
      ).rejects.toThrow('Network timeout');

      expect(mockChatCompletion).toHaveBeenCalledTimes(3); // 原始调用 + 2次重试
    });

    it('应该检测并拒绝空响应（如果启用）', async () => {
      const llmCallerWithRetry = new LlmCaller({
        maxRetries: 1,
        enableEmptyResponseRetry: true,
        retryDelayMs: 10,
        aiEngine,
        modelCatalog,
      });
      
      mockChatCompletion
        .mockResolvedValueOnce('   ') // 空白响应
        .mockResolvedValueOnce('Valid response');

      const result = await llmCallerWithRetry.callWithRetries(testModelId, testMessages);

      expect(result).toBe('Valid response');
      expect(mockChatCompletion).toHaveBeenCalledTimes(2);
    });

    it('应该支持流式调用的重试', async () => {
      const llmCallerWithRetry = new LlmCaller({ maxRetries: 1, retryDelayMs: 10, aiEngine, modelCatalog });
      
      // 第一次调用：抛出网络错误
      mockChatCompletionStream
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockImplementationOnce(
          async (modelId: any, messages: any, options: any, onContent: any) => {
            onContent('Success');
          }
        );

      const eventHandler = vi.fn();
      const result = await llmCallerWithRetry.callWithRetries(
        testModelId,
        testMessages,
        {},
        eventHandler
      );

      expect(result).toBe('Success');
      // 🔥 关键语义：重试期间不应向上游透传 error 事件，否则 UI 会误判流已结束
      const errorCalls = eventHandler.mock.calls.filter(call => call?.[0]?.type === 'error');
      expect(errorCalls.length).toBe(0);
    });

    it('流式 tool_call.arguments 非法时应按可重试错误自动重试', async () => {
      const llmCallerWithRetry = new LlmCaller({ maxRetries: 1, retryDelayMs: 1, aiEngine, modelCatalog });

      mockChatCompletionStream
        .mockImplementationOnce(
          async (_modelId: unknown, _messages: unknown, _options: unknown, onContent: (content: unknown) => void) => {
            onContent({
              tool_calls: [
                {
                  index: 0,
                  id: 'call_broken',
                  function: { name: 'ppt_plan' },
                },
              ],
            });
            onContent({
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"title":"下一代储能技术商业化路径分析","pages":[{"title":"封面页"' },
                },
              ],
            });
          }
        )
        .mockImplementationOnce(
          async (_modelId: unknown, _messages: unknown, _options: unknown, onContent: (content: unknown) => void) => {
            onContent({
              tool_calls: [
                {
                  index: 0,
                  id: 'call_ok',
                  function: { name: 'ppt_plan' },
                },
              ],
            });
            onContent({
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments:
                      '{"title":"下一代储能技术商业化路径分析","pages":[{"title":"封面页","elements":["主标题","副标题"]}]}',
                  },
                },
              ],
            });
          }
        );

      const eventHandler = vi.fn();
      const result = await llmCallerWithRetry.callWithRetries(
        testModelId,
        testMessages,
        {},
        eventHandler,
      );

      expect(typeof result).toBe('object');
      expect(mockChatCompletionStream).toHaveBeenCalledTimes(2);
      const errorCalls = eventHandler.mock.calls.filter((call) => call?.[0]?.type === 'error');
      expect(errorCalls.length).toBe(0);
    });

    it('应该在云端模型触发额度限制时自动切到 quota fallback，并且不消耗 retry 次数', async () => {
      const cloudModelId = 'cloud-primary-model';
      const quotaFallbackModelId = 'cloud-deepseek-reasoner';
      const onCloudQuotaFallbackApplied = vi.fn();

      mockGetModelById.mockImplementation((id: string) => {
        if (id === cloudModelId) {
          return {
            id: cloudModelId,
            model_name: 'primary',
            billing_mode: 'cloud',
            enable_client_retry: false,
            api_key: 'cloud-key',
          };
        }
        if (id === quotaFallbackModelId) {
          return {
            id: quotaFallbackModelId,
            model_name: 'deepseek-reasoner',
            billing_mode: 'cloud',
            enable_client_retry: false,
            api_key: 'fallback-key',
          };
        }
        return undefined;
      });

      mockChatCompletionStream.mockImplementation(
        async (
          modelId: string,
          _messages: AiMessage[],
          _options: Record<string, unknown>,
          onContent?: (content: string) => void,
          onError?: (error: Error) => void
        ) => {
          if (modelId === cloudModelId) {
            onContent?.('前半段');
            onError?.(new Error('今日使用次数已达上限（3次），明天再来吧'));
            return;
          }

          if (modelId === quotaFallbackModelId) {
            onContent?.('已切换到 deepseek 继续执行');
            return;
          }

          throw new Error(`unexpected model: ${modelId}`);
        }
      );

      const eventHandler = vi.fn();
      const result = await llmCaller.callWithRetries(
        cloudModelId,
        testMessages,
        { cloud_quota_fallback_model_id: quotaFallbackModelId },
        eventHandler,
        undefined,
        onCloudQuotaFallbackApplied,
      );

      expect(result).toBe('已切换到 deepseek 继续执行');
      expect(mockChatCompletionStream).toHaveBeenCalledTimes(2);
      expect(mockChatCompletionStream.mock.calls[0]?.[0]).toBe(cloudModelId);
      expect(mockChatCompletionStream.mock.calls[1]?.[0]).toBe(quotaFallbackModelId);
      expect(onCloudQuotaFallbackApplied).toHaveBeenCalledTimes(1);
      expect(onCloudQuotaFallbackApplied).toHaveBeenCalledWith(quotaFallbackModelId);

      const errorCalls = eventHandler.mock.calls.filter(call => call?.[0]?.type === 'error');
      expect(errorCalls.length).toBe(0);
    });

    it('云端模型即使禁用客户端重试，也应对损坏的 tool_call.arguments 做本地兜底重试', async () => {
      const cloudModelId = 'cloud-stream-model';

      mockGetModelById.mockImplementation((id: string) => {
        if (id === cloudModelId) {
          return {
            id: cloudModelId,
            model_name: 'cloud-stream',
            billing_mode: 'cloud',
            enable_client_retry: false,
            api_key: 'cloud-key',
          };
        }
        return undefined;
      });

      mockChatCompletionStream
        .mockImplementationOnce(
          async (_modelId: unknown, _messages: unknown, _options: unknown, onContent: (content: unknown) => void) => {
            onContent({
              tool_calls: [
                {
                  index: 0,
                  id: 'call_broken_cloud',
                  function: { name: 'ppt_plan' },
                },
              ],
            });
            onContent({
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"title":"损坏参数"' },
                },
              ],
            });
          }
        )
        .mockImplementationOnce(
          async (_modelId: unknown, _messages: unknown, _options: unknown, onContent: (content: unknown) => void) => {
            onContent({
              tool_calls: [
                {
                  index: 0,
                  id: 'call_ok_cloud',
                  function: { name: 'ppt_plan' },
                },
              ],
            });
            onContent({
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"title":"修复后参数","pages":[{"title":"封面页"}]}' },
                },
              ],
            });
          }
        );

      const result = await llmCaller.callWithRetries(
        cloudModelId,
        testMessages,
        {},
        vi.fn(),
      );

      expect(typeof result).toBe('object');
      expect(mockChatCompletionStream).toHaveBeenCalledTimes(2);
    });

    it('应该仅在最终失败时才向上游发出一次 error（流式重试场景）', async () => {
      const llmCallerWithRetry = new LlmCaller({ maxRetries: 1, retryDelayMs: 1, aiEngine, modelCatalog });

      const mockError = new Error('Rate limited');
      mockChatCompletionStream.mockImplementation(
        async (modelId: any, messages: any, options: any, onContent: any, onError: any) => {
          onError(mockError);
        }
      );

      const eventHandler = vi.fn();

      await expect(
        llmCallerWithRetry.callWithRetries(testModelId, testMessages, {}, eventHandler)
      ).rejects.toThrow('Rate limited');

      const errorCalls = eventHandler.mock.calls.filter(call => call?.[0]?.type === 'error');
      expect(errorCalls.length).toBe(1);
    });

    it('应该在取消信号触发时立即停止', async () => {
      const llmCallerWithRetry = new LlmCaller({ maxRetries: 3, retryDelayMs: 100, aiEngine, modelCatalog });
      
      const abortController = new AbortController();
      mockChatCompletion.mockRejectedValue(new Error('Network error'));

      // 在短时间后取消
      setTimeout(() => abortController.abort(), 50);

      await expect(
        llmCallerWithRetry.callWithRetries(
          testModelId,
          testMessages,
          {},
          undefined,
          abortController.signal
        )
      ).rejects.toThrow(/cancelled|abort/i);
    });

    it('应该正确分类不可重试的错误', async () => {
      const llmCallerWithRetry = new LlmCaller({ maxRetries: 2, aiEngine, modelCatalog });
      
      // 模拟一个不可重试的错误（如权限错误）
      const authError = new Error('Invalid API key');
      authError.name = 'AuthenticationError';
      mockChatCompletion.mockRejectedValue(authError);

      await expect(
        llmCallerWithRetry.callWithRetries(testModelId, testMessages)
      ).rejects.toThrow('Invalid API key');

      // 不应该重试
      expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    });

    it('应该处理速率限制错误并使用更长延迟', async () => {
      const llmCallerWithRetry = new LlmCaller({ maxRetries: 1, retryDelayMs: 10, aiEngine, modelCatalog });
      
      const rateLimitError = new Error('Rate limit exceeded');
      rateLimitError.name = 'RateLimitError';
      
      mockChatCompletion
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce('Success');

      const startTime = Date.now();
      const result = await llmCallerWithRetry.callWithRetries(testModelId, testMessages);
      const endTime = Date.now();

      expect(result).toBe('Success');
      // 验证确实有延迟（至少10ms）
      expect(endTime - startTime).toBeGreaterThanOrEqual(10);
    });
  });

  describe('边界条件和错误处理', () => {
    it('应该处理 undefined 响应', async () => {
      mockChatCompletion.mockResolvedValue(undefined);

      const result = await llmCaller.call(testModelId, testMessages);

      expect(result).toBe('undefined');
    });

    it('应该处理 null 响应', async () => {
      mockChatCompletion.mockResolvedValue(null);

      const result = await llmCaller.call(testModelId, testMessages);

      expect(result).toBe('null');
    });

    it('应该处理数字响应', async () => {
      mockChatCompletion.mockResolvedValue(42);

      const result = await llmCaller.call(testModelId, testMessages);

      expect(result).toBe('42');
    });

    it('应该处理复杂对象响应', async () => {
      const complexResponse = {
        data: { nested: 'value' },
        meta: { count: 1 },
      };
      mockChatCompletion.mockResolvedValue(complexResponse);

      const result = await llmCaller.call(testModelId, testMessages);

      expect(result).toBe(JSON.stringify(complexResponse));
    });

    it('应该在流式调用中忽略空的 thought', async () => {
      mockChatCompletionStream.mockImplementation(
        async (modelId: any, messages: any, options: any, onContent: any, onError: any, onFinish: any, onThought: any) => {
          onThought(''); // 空 thought
          onThought('   '); // 空白 thought
          onContent('Actual content');
        }
      );

      const events: AnyAgentEvent[] = [];
      await llmCaller.callStream(testModelId, testMessages, {}, (event) => events.push(event));

      const thoughtEvents = events.filter(e => e.type === 'thought');
      // 空的 thought 应该被忽略（根据实现中的 if (!thought) return;）
      expect(thoughtEvents.length).toBe(0);
    });
  });

  describe('性能和并发', () => {
    it('应该能够处理多个并发调用', async () => {
      mockChatCompletion.mockImplementation(async () => {
        // 模拟网络延迟
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'Response';
      });

      const promises = Array.from({ length: 10 }, () =>
        llmCaller.call(testModelId, testMessages)
      );

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      expect(results.every(r => r === 'Response')).toBe(true);
      expect(mockChatCompletion).toHaveBeenCalledTimes(10);
    });

    it('应该能够处理大量消息历史', async () => {
      const largeMessages: AiMessage[] = Array.from({ length: 100 }, (_, i) => {
        const isUser = i % 2 === 0;
        return {
          role: isUser ? 'user' : 'assistant',
          type: isUser ? 'user_input' : 'final_answer',
          content: `Message ${i}`,
          id: `msg_${i}`,
          timestamp: Date.now() + i,
        } as AiMessage;
      });

      mockChatCompletion.mockResolvedValue('Response');

      const result = await llmCaller.call(testModelId, largeMessages);

      expect(result).toBe('Response');
      expect(mockChatCompletion).toHaveBeenCalledWith(
        testModelId,
        largeMessages,
        expect.any(Object)
      );
    });
  });
});
