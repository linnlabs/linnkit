import { describe, expect, it } from 'vitest';
import {
  createAiSdkInferenceCapability,
  createAiSdkLanguageModelRegistry,
} from '@linnlabs/linnkit-provider-ai-sdk';
import {
  collectProviderSurfaceEvents as collect,
  providerSurfaceEventStream as eventStream,
  providerSurfaceInvocation as invocation,
  providerSurfaceRoute as route,
  providerSurfaceToolImageInvocation as toolImageInvocation,
} from '../fixtures/providerSurfaceCodecFixture';

describe('AI SDK official Provider codec conformance', () => {
  it.each([
    {
      capabilityId: 'ai-sdk:openai-compatible',
      surface: 'openai_chat_completions',
      modelId: 'glm-5.3',
      path: '/chat/completions',
    },
    {
      capabilityId: 'ai-sdk:openai-responses',
      surface: 'openai_responses',
      modelId: 'gpt-5.6-luna',
      path: '/responses',
    },
    {
      capabilityId: 'ai-sdk:anthropic-messages',
      surface: 'anthropic_messages',
      modelId: 'qwen3.8-max',
      path: '/messages',
    },
  ] as const)(
    'OpenCode Go 的 $modelId 通过正式 $surface codec 与共享 Bearer 凭据发起请求',
    async ({ capabilityId, surface, modelId, path }) => {
      const resolvedRoute = {
        ...route(capabilityId, surface, 'bearer'),
        base_url: 'https://opencode.ai/zen/go/v1',
        endpoint_model_id: modelId,
      };
      let requestUrl = '';
      let requestHeaders = new Headers();
      const fixtureFetch: typeof fetch = async (input, init) => {
        requestUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ error: { message: 'fixture stop' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      };
      const capability = createAiSdkInferenceCapability(capabilityId, surface, {
        language_models: createAiSdkLanguageModelRegistry(fixtureFetch),
      });

      await collect(capability.stream(invocation(resolvedRoute)));

      expect(requestUrl).toBe(`https://opencode.ai/zen/go/v1${path}`);
      expect(requestHeaders.get('authorization')).toBe('Bearer fixture-secret');
      expect(requestHeaders.get('x-api-key')).toBeNull();
    }
  );

  it('Responses、Anthropic 与 Google 原生 codec 保留工具图片角色', async () => {
    const routes = [
      route('ai-sdk:openai-responses', 'openai_responses', 'bearer'),
      route('ai-sdk:anthropic-messages', 'anthropic_messages', 'api_key'),
      route('ai-sdk:google-generative-ai', 'google_generative_ai', 'api_key'),
    ] as const;
    const bodies: unknown[] = [];

    for (const resolvedRoute of routes) {
      const fixtureFetch: typeof fetch = async (_input, init) => {
        bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
        return new Response(JSON.stringify({ error: { message: 'fixture stop' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      };
      const capability = createAiSdkInferenceCapability(
        resolvedRoute.capability_id,
        resolvedRoute.surface,
        { language_models: createAiSdkLanguageModelRegistry(fixtureFetch) }
      );
      await collect(capability.stream(toolImageInvocation(resolvedRoute)));
    }

    expect(bodies[0]).toMatchObject({
      input: [
        { role: 'user' },
        { type: 'function_call', call_id: 'call-image' },
        {
          type: 'function_call_output',
          call_id: 'call-image',
          output: [
            { type: 'input_text', text: '图片读取成功' },
            { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
          ],
        },
      ],
    });
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: 'user' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call-image' }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call-image',
            content: [
              { type: 'text', text: '图片读取成功' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
            ],
          }],
        },
      ],
    });
    expect(bodies[2]).toMatchObject({
      contents: [
        { role: 'user' },
        { role: 'model', parts: [{ functionCall: { name: 'read_file' } }] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-image',
                name: 'read_file',
                response: { name: 'read_file', content: '图片读取成功' },
              },
            },
            { inlineData: { mimeType: 'image/png', data: 'AQID' } },
            { text: 'Tool executed successfully and returned this image as a response' },
          ],
        },
      ],
    });
  });

  it('OpenAI Responses 从正式 codec 投影文本与 raw usage', async () => {
    const resolvedRoute = route('ai-sdk:openai-responses', 'openai_responses', 'bearer');
    let requestUrl = '';
    let requestBody: unknown;
    const fixtureFetch: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      if (typeof init?.body === 'string') requestBody = JSON.parse(init.body);
      return eventStream([
        JSON.stringify({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'message-1', phase: 'final_answer' },
        }),
        JSON.stringify({
          type: 'response.output_text.delta',
          item_id: 'message-1',
          output_index: 0,
          delta: 'responses answer',
        }),
        JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'message-1',
            phase: 'final_answer',
            content: [],
          },
        }),
        JSON.stringify({
          type: 'response.completed',
          response: {
            incomplete_details: null,
            usage: {
              input_tokens: 14,
              input_tokens_details: { cached_tokens: 3 },
              output_tokens: 6,
              output_tokens_details: { reasoning_tokens: 2 },
            },
            reasoning: null,
            service_tier: null,
          },
        }),
      ]);
    };
    const capability = createAiSdkInferenceCapability(
      resolvedRoute.capability_id,
      resolvedRoute.surface,
      { language_models: createAiSdkLanguageModelRegistry(fixtureFetch) }
    );

    const events = await collect(capability.stream(invocation(resolvedRoute)));

    expect(requestUrl).toBe('https://fixture.invalid/v1/responses');
    expect(requestBody).toMatchObject({
      model: resolvedRoute.endpoint_model_id,
      stream: true,
      store: false,
      temperature: 0,
      max_output_tokens: 128,
    });
    expect(events).toEqual([
      { type: 'start', model_id: resolvedRoute.model_id, attempt_id: 'attempt-1' },
      { type: 'answer_delta', text: 'responses answer' },
      {
        type: 'assistant_part_end',
        index: 0,
        part: {
          type: 'text',
          text: 'responses answer',
          continuation: [{
          schema_version: 2,
          producer: {
            model_id: resolvedRoute.model_id,
            endpoint_id: resolvedRoute.endpoint_id,
            api_surface: resolvedRoute.surface,
            capability_id: resolvedRoute.capability_id,
            endpoint_model_id: resolvedRoute.endpoint_model_id,
          },
          kind: 'ai-sdk:openai-responses-part',
            payload: { target: 'text', text: 'responses answer', item_id: 'message-1' },
          }],
        },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 11,
          outputTokens: 6,
          cacheReadTokens: 3,
          reasoningTokens: 2,
          source: 'provider-response-usage',
          confidence: 'actual',
          rawUsage: {
            input_tokens: 14,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens: 6,
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('OpenAI Responses 兼容网关的 max_tokens incomplete 经正式 codec 投影为 length', async () => {
    const resolvedRoute = route('ai-sdk:openai-responses', 'openai_responses', 'bearer');
    const fixtureFetch: typeof fetch = async () => eventStream([
      JSON.stringify({
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_tokens' },
          usage: {
            input_tokens: 14,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 128,
            output_tokens_details: { reasoning_tokens: 128 },
          },
          reasoning: null,
          service_tier: null,
        },
      }),
    ]);
    const capability = createAiSdkInferenceCapability(
      resolvedRoute.capability_id,
      resolvedRoute.surface,
      { language_models: createAiSdkLanguageModelRegistry(fixtureFetch) }
    );

    const events = await collect(capability.stream(invocation(resolvedRoute)));

    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'length' });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'failure' }));
  });

  it('OpenAI Responses 的 server_error incomplete 经正式 codec 投影为可重试 Provider 故障', async () => {
    const resolvedRoute = route('ai-sdk:openai-responses', 'openai_responses', 'bearer');
    const fixtureFetch: typeof fetch = async () => eventStream([
      JSON.stringify({
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'server_error' },
          usage: {
            input_tokens: 14,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
          },
          reasoning: null,
          service_tier: null,
        },
      }),
    ]);
    const capability = createAiSdkInferenceCapability(
      resolvedRoute.capability_id,
      resolvedRoute.surface,
      { language_models: createAiSdkLanguageModelRegistry(fixtureFetch) }
    );

    const events = await collect(capability.stream(invocation(resolvedRoute)));

    expect(events[events.length - 1]).toEqual({
      type: 'failure',
      kind: 'provider',
      code: 'provider_stream_unavailable',
      retryable: true,
    });
  });

  it('OpenAI Responses 已输出 reasoning 后的 response.failed 仍投影为可重试 Provider 故障', async () => {
    const resolvedRoute = route('ai-sdk:openai-responses', 'openai_responses', 'bearer');
    const fixtureFetch: typeof fetch = async () => eventStream([
      JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'encrypted-1' },
      }),
      JSON.stringify({
        type: 'response.reasoning_summary_part.added',
        item_id: 'reasoning-1',
        output_index: 0,
        summary_index: 0,
      }),
      JSON.stringify({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'reasoning-1',
        output_index: 0,
        summary_index: 0,
        delta: 'planning file creation',
      }),
      JSON.stringify({
        type: 'response.reasoning_summary_part.done',
        item_id: 'reasoning-1',
        output_index: 0,
        summary_index: 0,
      }),
      JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'encrypted-1' },
      }),
      JSON.stringify({
        type: 'response.failed',
        sequence_number: 6,
        response: {
          error: { code: 'server_error', message: 'sensitive upstream response' },
          incomplete_details: null,
          usage: null,
          reasoning: null,
          service_tier: null,
        },
      }),
    ]);
    const capability = createAiSdkInferenceCapability(
      resolvedRoute.capability_id,
      resolvedRoute.surface,
      { language_models: createAiSdkLanguageModelRegistry(fixtureFetch) }
    );

    const events = await collect(capability.stream(invocation(resolvedRoute)));

    expect(events).toContainEqual({ type: 'thought_delta', text: 'planning file creation' });
    expect(events[events.length - 1]).toEqual({
      type: 'failure',
      kind: 'provider',
      code: 'provider_stream_unavailable',
      retryable: true,
    });
    expect(JSON.stringify(events)).not.toContain('sensitive upstream response');
    expect(events).not.toContainEqual(expect.objectContaining({
      code: 'provider_stream_lifecycle_invalid',
    }));
  });

  it('Anthropic Messages 从正式 codec 投影 thinking signature、文本和 raw usage', async () => {
    const resolvedRoute = route('ai-sdk:anthropic-messages', 'anthropic_messages', 'api_key');
    let requestUrl = '';
    let apiKey: string | null = null;
    const fixtureFetch: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      apiKey = new Headers(init?.headers).get('x-api-key');
      return eventStream([
        JSON.stringify({
          type: 'message_start',
          message: {
            id: 'message-1',
            model: resolvedRoute.endpoint_model_id,
            role: 'assistant',
            usage: {
              input_tokens: 12,
              cache_creation_input_tokens: 2,
              cache_read_input_tokens: 3,
            },
          },
        }),
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'reasoning' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'signature-1' },
        }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'anthropic answer' },
        }),
        JSON.stringify({ type: 'content_block_stop', index: 1 }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: {
            output_tokens: 7,
            output_tokens_details: { thinking_tokens: 2 },
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        }),
        JSON.stringify({ type: 'message_stop' }),
      ]);
    };
    const capability = createAiSdkInferenceCapability(
      resolvedRoute.capability_id,
      resolvedRoute.surface,
      { language_models: createAiSdkLanguageModelRegistry(fixtureFetch) }
    );

    const events = await collect(capability.stream(invocation(resolvedRoute)));

    expect(requestUrl).toBe('https://fixture.invalid/v1/messages');
    expect(apiKey).toBe('fixture-secret');
    expect(events).toEqual([
      { type: 'start', model_id: resolvedRoute.model_id, attempt_id: 'attempt-1' },
      { type: 'thought_delta', text: 'reasoning' },
      {
        type: 'assistant_part_end',
        index: 0,
        part: {
          type: 'reasoning',
          text: 'reasoning',
          continuation: [{
          schema_version: 2,
          producer: {
            model_id: resolvedRoute.model_id,
            endpoint_id: resolvedRoute.endpoint_id,
            api_surface: resolvedRoute.surface,
            capability_id: resolvedRoute.capability_id,
            endpoint_model_id: resolvedRoute.endpoint_model_id,
          },
          kind: 'ai-sdk:anthropic-reasoning',
            payload: {
              target: 'reasoning',
              text: 'reasoning',
              signature: 'signature-1',
            },
          }],
        },
      },
      { type: 'answer_delta', text: 'anthropic answer' },
      {
        type: 'assistant_part_end',
        index: 1,
        part: { type: 'text', text: 'anthropic answer' },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          reasoningTokens: 2,
          source: 'provider-response-usage',
          confidence: 'actual',
          rawUsage: {
            input_tokens: 12,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 7,
            output_tokens_details: { thinking_tokens: 2 },
          },
        },
      },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('Google Generative AI 从正式 codec 投影 thought signature、文本和 raw usage', async () => {
    const resolvedRoute = route('ai-sdk:google-generative-ai', 'google_generative_ai', 'api_key');
    let requestUrl = '';
    let apiKey: string | null = null;
    const fixtureFetch: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      apiKey = new Headers(init?.headers).get('x-goog-api-key');
      return eventStream([
        JSON.stringify({
          responseId: 'response-1',
          candidates: [{
            content: {
              role: 'model',
              parts: [
                { text: 'google reasoning', thought: true, thoughtSignature: 'signature-1' },
                { text: 'google answer', thoughtSignature: 'signature-2' },
              ],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 6,
            cachedContentTokenCount: 4,
            thoughtsTokenCount: 2,
            totalTokenCount: 21,
          },
        }),
      ]);
    };
    const capability = createAiSdkInferenceCapability(
      resolvedRoute.capability_id,
      resolvedRoute.surface,
      { language_models: createAiSdkLanguageModelRegistry(fixtureFetch) }
    );

    const events = await collect(capability.stream(invocation(resolvedRoute)));

    expect(requestUrl).toContain(':streamGenerateContent?alt=sse');
    expect(apiKey).toBe('fixture-secret');
    expect(events).toEqual([
      { type: 'start', model_id: resolvedRoute.model_id, attempt_id: 'attempt-1' },
      { type: 'thought_delta', text: 'google reasoning' },
      {
        type: 'assistant_part_end',
        index: 0,
        part: {
          type: 'reasoning',
          text: 'google reasoning',
          continuation: [{
          schema_version: 2,
          producer: {
            model_id: resolvedRoute.model_id,
            endpoint_id: resolvedRoute.endpoint_id,
            api_surface: resolvedRoute.surface,
            capability_id: resolvedRoute.capability_id,
            endpoint_model_id: resolvedRoute.endpoint_model_id,
          },
          kind: 'ai-sdk:google-part',
            payload: {
              target: 'reasoning',
              text: 'google reasoning',
              thought_signature: 'signature-1',
            },
          }],
        },
      },
      { type: 'answer_delta', text: 'google answer' },
      {
        type: 'assistant_part_end',
        index: 1,
        part: {
          type: 'text',
          text: 'google answer',
          continuation: [{
          schema_version: 2,
          producer: {
            model_id: resolvedRoute.model_id,
            endpoint_id: resolvedRoute.endpoint_id,
            api_surface: resolvedRoute.surface,
            capability_id: resolvedRoute.capability_id,
            endpoint_model_id: resolvedRoute.endpoint_model_id,
          },
          kind: 'ai-sdk:google-part',
            payload: {
              target: 'text',
              text: 'google answer',
              thought_signature: 'signature-2',
            },
          }],
        },
      },
      {
        type: 'usage',
        usage: {
          inputTokens: 11,
          outputTokens: 8,
          cacheReadTokens: 4,
          reasoningTokens: 2,
          source: 'provider-response-usage',
          confidence: 'actual',
          rawUsage: {
            promptTokenCount: 15,
            candidatesTokenCount: 6,
            cachedContentTokenCount: 4,
            thoughtsTokenCount: 2,
            totalTokenCount: 21,
          },
        },
      },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});
