import type { CanonicalInferenceRequest, ProviderContinuation } from '@linnlabs/linnkit/ports';
import { describe, expect, it } from 'vitest';
import type { AiSdkInferenceRoute } from '../definitions/aiSdkInferenceSurface';
import {
  projectAiSdkRequestProviderOptions,
  projectCanonicalMessages,
  projectCanonicalToolConfiguration,
} from './projectCanonicalRequestToAiSdk';

const route: AiSdkInferenceRoute = {
  model_id: 'model-1',
  request_profile: 'openai_responses',
  capability_id: 'ai-sdk:openai-responses',
  endpoint_id: 'openai',
  endpoint_model_id: 'gpt-5',
  surface: 'openai_responses',
  base_url: 'https://api.openai.com/v1',
};

function continuation(
  kind: ProviderContinuation['kind'],
  payload: ProviderContinuation['payload']
): ProviderContinuation {
  return {
    schema_version: 2,
    producer: {
      model_id: route.model_id,
      endpoint_id: route.endpoint_id,
      api_surface: route.surface,
      capability_id: route.capability_id,
      endpoint_model_id: route.endpoint_model_id,
    },
    kind,
    payload,
  };
}

function request(): CanonicalInferenceRequest {
  return {
    model_id: route.model_id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{
      name: 'read_file',
      description: 'Read one file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path' } },
        required: ['path'],
        additionalProperties: false,
      },
    }],
    tool_choice: { type: 'tool', name: 'read_file' },
    sampling: {},
    invocation: { trace_id: 'trace-1', attempt_id: 'attempt-1' },
  };
}

describe('projectCanonicalRequestToAiSdk', () => {
  it('原样投影 JSON Schema，工具对象不具有 execute 或 approval 能力', () => {
    const input = request();
    const configuration = projectCanonicalToolConfiguration(input);
    const tools = configuration.tools;
    if (!tools) throw new Error('期望投影出工具配置');
    expect(tools.read_file).toBeDefined();
    expect(tools.read_file).not.toHaveProperty('execute');
    expect(tools.read_file).not.toHaveProperty('needsApproval');
    expect(tools.read_file?.inputSchema).toBeDefined();
    expect(configuration.toolChoice).toEqual({
      type: 'tool',
      toolName: 'read_file',
    });
  });

  it('没有候选工具时省略整个 AI SDK 工具配置', () => {
    const input = request();
    expect(projectCanonicalToolConfiguration({
      ...input,
      tools: [],
      tool_choice: 'auto',
    })).toEqual({});
  });

  it('有候选工具时仍省略 canonical auto，只保留工具定义', () => {
    const input = request();
    const configuration = projectCanonicalToolConfiguration({
      ...input,
      tool_choice: 'auto',
    });

    expect(configuration.tools?.read_file).toBeDefined();
    expect(configuration).not.toHaveProperty('toolChoice');
  });

  it('从已完成 assistant tool call 严格解析 tool result 的名字并保留图片 bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const messages = projectCanonicalMessages([
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call',
          call: { id: 'call-1', name: 'read_file', arguments: { path: '/a' } },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: [
          { type: 'text', text: 'done' },
          { type: 'image', media_type: 'image/png', bytes },
        ],
      },
    ], route);
    expect(messages[1]).toEqual({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'read_file',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: 'done' },
            {
              type: 'file',
              data: { type: 'data', data: bytes },
              mediaType: 'image/png',
            },
          ],
        },
      }],
    });
  });

  it('拒绝没有 assistant producer 的孤立 tool result', () => {
    expect(() => projectCanonicalMessages([{
      role: 'tool',
      tool_call_id: 'missing',
      content: [{ type: 'text', text: 'done' }],
    }], route)).toThrow(/找不到已完成的 assistant tool call/);
  });

  it('把 OpenAI Responses reasoning 与 tool item metadata 还原为 part providerOptions', () => {
    const messages = projectCanonicalMessages([{
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'thinking',
          continuation: [continuation('ai-sdk:openai-responses-part', {
            target: 'reasoning',
            text: 'thinking',
            item_id: 'reasoning-1',
            reasoning_encrypted_content: 'encrypted',
          })],
        },
        { type: 'text', text: 'answer' },
        {
          type: 'tool_call',
          call: {
            id: 'call-1',
            name: 'read_file',
            arguments: { path: '/a' },
            continuation: [continuation('ai-sdk:openai-responses-part', {
              target: 'tool_call',
              tool_call_id: 'call-1',
              item_id: 'item-call-1',
            })],
          },
        },
      ],
    }], route);
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'thinking',
          providerOptions: {
            openai: {
              itemId: 'reasoning-1',
              reasoningEncryptedContent: 'encrypted',
            },
          },
        },
        { type: 'text', text: 'answer' },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'read_file',
          input: { path: '/a' },
          providerOptions: { openai: { itemId: 'item-call-1' } },
        },
      ],
    });
  });

  it('把 xAI Responses continuation 和无状态请求选项投影到 xai namespace', () => {
    const xAiRoute = {
      ...route,
      capability_id: 'ai-sdk:xai-responses',
      endpoint_id: 'xai',
      endpoint_model_id: 'grok-4.1-fast-reasoning',
    } satisfies AiSdkInferenceRoute;
    const xAiContinuation: ProviderContinuation = {
      schema_version: 2,
      producer: {
        model_id: xAiRoute.model_id,
        endpoint_id: xAiRoute.endpoint_id,
        api_surface: xAiRoute.surface,
        capability_id: xAiRoute.capability_id,
        endpoint_model_id: xAiRoute.endpoint_model_id,
      },
      kind: 'ai-sdk:xai-responses-part',
      payload: {
        target: 'reasoning',
        text: 'thinking',
        item_id: 'reasoning-1',
        reasoning_encrypted_content: 'encrypted',
      },
    };

    expect(projectCanonicalMessages([{
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'thinking', continuation: [xAiContinuation] }],
    }], xAiRoute)).toEqual([{
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: 'thinking',
        providerOptions: {
          xai: { itemId: 'reasoning-1', reasoningEncryptedContent: 'encrypted' },
        },
      }],
    }]);
    expect(projectAiSdkRequestProviderOptions(request(), xAiRoute)).toEqual({
      xai: { store: false },
    });
  });

  it('producer route 不一致时拒绝回放 continuation', () => {
    const mismatched = continuation('ai-sdk:openai-responses-part', {
      target: 'reasoning',
      text: 'thinking',
      item_id: 'reasoning-1',
    });
    expect(() => projectCanonicalMessages([{
      role: 'assistant',
      parts: [{
        type: 'reasoning',
        text: 'thinking',
        continuation: [{
          ...mismatched,
          producer: { ...mismatched.producer, endpoint_model_id: 'other-model' },
        }],
      }],
    }], route)).toThrow(/与当前 route 不一致/);
  });

  it('tool continuation 必须绑定当前 tool part', () => {
    expect(() => projectCanonicalMessages([{
      role: 'assistant',
      parts: [{
        type: 'tool_call',
        call: {
          id: 'call-1',
          name: 'read_file',
          arguments: { path: '/a' },
          continuation: [continuation('ai-sdk:openai-responses-part', {
            target: 'tool_call',
            tool_call_id: 'call-other',
            item_id: 'item-call-1',
          })],
        },
      }],
    }], route)).toThrow(/tool_call_id 与 assistant tool part 不一致/);
  });
});
