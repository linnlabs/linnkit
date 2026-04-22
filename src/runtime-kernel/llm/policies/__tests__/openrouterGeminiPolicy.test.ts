import { describe, expect, it } from 'vitest';
import { openrouterGeminiPolicy } from '../openrouterGeminiPolicy';

describe('openrouterGeminiPolicy', () => {
  it('beforeRequest: 默认注入 reasoning.enabled=true 且 exclude=false（不覆盖用户显式配置）', () => {
    const ctx = {
      modelId: 'google/gemini-3-pro-preview',
      apiBase: 'https://openrouter.ai/api/v1',
      requestModelName: 'google/gemini-3-pro-preview',
      endpoint: 'chat/completions',
      requestData: {
        model: 'google/gemini-3-pro-preview',
        messages: [{ role: 'user', content: 'hi' }]
      }
    } as any;

    const out = openrouterGeminiPolicy.beforeRequest?.(ctx);
    expect(out?.requestData?.reasoning).toEqual({ enabled: true, exclude: false });

    const ctx2 = {
      ...ctx,
      requestData: { ...ctx.requestData, reasoning: { effort: 'high', exclude: false } }
    } as any;
    const out2 = openrouterGeminiPolicy.beforeRequest?.(ctx2);
    expect(out2?.requestData?.reasoning).toEqual({ effort: 'high', exclude: false });
  });

  it('beforeRequest: role=model/tool_calls 时应归一化为 assistant，并从 reasoning_details 提取 thoughtSignature 填入 tool_calls[0].extra_content.google.thought_signature', () => {
    const ctx = {
      modelId: 'google/gemini-3-pro-preview',
      apiBase: 'https://openrouter.ai/api/v1',
      requestModelName: 'google/gemini-3-pro-preview',
      endpoint: 'chat/completions',
      headers: {},
      requestData: {
        model: 'google/gemini-3-pro-preview',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'model',
            content: null,
            tool_calls: [
              {
                id: 'function-call-1',
                type: 'function',
                function: { name: 'default_api:markdown_edit', arguments: '{}' }
              }
            ],
            reasoning_details: [
              { type: 'functionCall', thoughtSignature: '<Sig_A>', functionCall: { name: 'x' } }
            ]
          }
        ]
      }
    } as any;

    const out = openrouterGeminiPolicy.beforeRequest?.(ctx);
    expect(out?.requestData).toBeTruthy();

    const msgs = out!.requestData.messages;
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].tool_calls[0].extra_content.google.thought_signature).toBe('<Sig_A>');
  });

  it('beforeRequest: role 缺失但有 tool_calls 时，也应归一化为 assistant 并补齐签名', () => {
    const ctx = {
      modelId: 'google/gemini-3-pro-preview',
      apiBase: 'https://openrouter.ai/api/v1',
      requestModelName: 'google/gemini-3-pro-preview',
      endpoint: 'chat/completions',
      requestData: {
        model: 'google/gemini-3-pro-preview',
        messages: [
          { role: 'user', content: 'hi' },
          {
            // role missing
            tool_calls: [
              {
                id: 'function-call-1',
                type: 'function',
                function: { name: 'default_api:markdown_edit', arguments: '{}' }
              }
            ],
            reasoning_details: [{ thoughtSignature: '<Sig_X>' }]
          }
        ]
      }
    } as any;

    const out = openrouterGeminiPolicy.beforeRequest?.(ctx);
    const msg = out!.requestData.messages[1];
    expect(msg.role).toBe('assistant');
    expect(msg.tool_calls[0].extra_content.google.thought_signature).toBe('<Sig_X>');
  });

  it('beforeRequest: 若无法从 reasoning_details 提取签名，应写入 dummy thought_signature', () => {
    const ctx = {
      modelId: 'google/gemini-3-pro-preview',
      apiBase: 'https://openrouter.ai/api/v1',
      requestModelName: 'google/gemini-3-pro-preview',
      endpoint: 'chat/completions',
      requestData: {
        model: 'google/gemini-3-pro-preview',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'function-call-1',
                type: 'function',
                function: { name: 'default_api:workspace_read_documents', arguments: '{}' }
              }
            ],
            // 注意：reasoning_details 必须非空（OpenRouter 要求“原样回放 reasoning blocks”）
            // 这里构造一个“不含 thoughtSignature”的 block，用于触发 dummy 兜底逻辑。
            reasoning_details: [{ type: 'thinking', text: 'no signature here' }]
          }
        ]
      }
    } as any;

    const out = openrouterGeminiPolicy.beforeRequest?.(ctx);
    const sig = out!.requestData.messages[1].tool_calls[0].extra_content.google.thought_signature;
    expect(sig).toBe('context_engineering_is_the_way_to_go');
  });

  it('beforeRequest: 若 tool_calls[0] 已包含 thought_signature，不应覆盖', () => {
    const ctx = {
      modelId: 'google/gemini-3-pro-preview',
      apiBase: 'https://openrouter.ai/api/v1',
      requestModelName: 'google/gemini-3-pro-preview',
      endpoint: 'chat/completions',
      requestData: {
        model: 'google/gemini-3-pro-preview',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'function-call-1',
                type: 'function',
                function: { name: 'default_api:workspace_read_documents', arguments: '{}' },
                extra_content: { google: { thought_signature: '<Existing>' } }
              }
            ],
            reasoning_details: [{ thoughtSignature: '<Sig_A>' }]
          }
        ]
      }
    } as any;

    const out = openrouterGeminiPolicy.beforeRequest?.(ctx);
    const sig = out!.requestData.messages[1].tool_calls[0].extra_content.google.thought_signature;
    expect(sig).toBe('<Existing>');
  });

  it('beforeRequest: 如果历史 tool_calls 缺 reasoning_details，应把该段 tool 交互降级为纯文本（避免 Vertex 校验卡死）', () => {
    const ctx = {
      modelId: 'google/gemini-3-pro-preview',
      apiBase: 'https://openrouter.ai/api/v1',
      requestModelName: 'google/gemini-3-pro-preview',
      endpoint: 'chat/completions',
      requestData: {
        model: 'google/gemini-3-pro-preview',
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'function-call-1',
                type: 'function',
                function: { name: 'markdown_edit', arguments: '{}' }
              }
            ]
            // reasoning_details missing
          },
          {
            role: 'tool',
            tool_call_id: 'function-call-1',
            content: 'ok'
          },
          { role: 'assistant', content: 'next' }
        ]
      }
    } as any;

    const out = openrouterGeminiPolicy.beforeRequest?.(ctx);
    const msgs = out!.requestData.messages;
    expect(msgs[1].role).toBe('assistant');
    expect(typeof msgs[1].content).toBe('string');
    expect(msgs[1].tool_calls).toBeUndefined();
    expect(msgs[2].role).toBe('assistant');
    expect(typeof msgs[2].content).toBe('string');
    expect(msgs[3].content).toBe('next');
  });

  it('afterResponse: 若 response message.tool_calls[0] 缺 signature，应补齐（从 message.reasoning_details 提取）', () => {
    const responseData = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'function-call-1',
                type: 'function',
                function: { name: 'default_api:workspace_read_documents', arguments: '{}' }
              }
            ],
            reasoning_details: [{ thought_signature: '<Sig_B>' }]
          }
        }
      ]
    };

    const out = openrouterGeminiPolicy.afterResponse?.({
      modelId: 'google/gemini-3-pro-preview',
      apiBase: 'https://openrouter.ai/api/v1',
      requestModelName: 'google/gemini-3-pro-preview',
      endpoint: 'chat/completions',
      responseData
    } as any);

    const sig = out!.responseData.choices[0].message.tool_calls[0].extra_content.google.thought_signature;
    expect(sig).toBe('<Sig_B>');
  });
});
