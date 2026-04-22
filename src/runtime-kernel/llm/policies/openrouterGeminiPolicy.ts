/**
 * @file src/agent/runtime-kernel/llm/policies/openrouterGeminiPolicy.ts
 *
 * @description
 * OpenRouter + Gemini (Vertex) 的差异策略（重要，踩坑总结）：
 *
 * ## 背景：为什么会出现 400 missing thought_signature
 * 当 Gemini（尤其是 Gemini 3 / 2.5 thinking）通过 OpenRouter 走工具调用时，OpenRouter/Vertex 会启用
 * “preserving reasoning blocks”的严格校验：
 *
 * - **模型响应里会返回 `reasoning_details`（一串 reasoning blocks）**
 * - **下一次请求必须把这些 `reasoning_details` 原样放回到上一条 assistant/tool_calls 消息中**
 *   - 不能改内容、不能重排、不能丢字段
 * - 如果 `reasoning_details` 丢失，上游在校验 functionCall 所在的 content/part 时会判定
 *   “缺少 thought_signature”，从而稳定返回 400
 *
 * 这就是为什么“仅仅在 OpenAI-compat 的 tool_calls 上补 thought_signature”有时仍会失败：
 * 上游真正关心的是 reasoning blocks 的回放连续性，而不是我们自认为的某个字段是否存在。
 *
 * ## 本 policy 的职责边界（我们在这里兜底，主链路不动）
 * - **beforeRequest**
 *   1) 归一化 role（Google 生态可能用 role="model"，OpenAI-compat 只接受 assistant）
 *   2) 尝试从 reasoning_details 提取 thoughtSignature，并写入
 *      `tool_calls[0].extra_content.google.thought_signature`
 *   3) 默认注入 OpenRouter 的 `reasoning` 参数，确保不要把 reasoning 排除掉（否则拿不到 reasoning_details）
 *   4) 如果发现历史里存在 tool_calls 但缺 reasoning_details，则做“降级兜底”（见下）
 * - **afterResponse**
 *   - 尽量只做“补齐”：若响应里 tool_calls 缺 thought_signature，尝试从 message.reasoning_details 提取补齐
 *
 * ## 降级兜底（为什么需要）
 * OpenRouter 官方要求：follow-up request 需要回放上一轮返回的 `reasoning_details`（原样）。
 * 但如果我们的历史里已经缺了 reasoning_details（例如旧版本没保存、或之前的响应没解析到），
 * 继续按 tool_calls 结构发送只会稳定 400，导致整个会话卡死。
 *
 * 因此这里提供一个“最后兜底”：
 * - 把缺 reasoning_details 的 assistant/tool_calls 及其后续 tool 输出，降级为普通文本（assistant content）
 * - 副作用：丢失结构化工具回放信息，但能让会话继续推进（避免永久 400）
 *
 * ## 参考（便于后续维护者核对协议）
 * - OpenRouter: Preserving reasoning blocks（要求回放 reasoning_details）
 * - Google Vertex AI / Gemini: Thought signatures（function calling 的严格校验）
 */

import type { LLMPolicy, LLMPolicyMatchContext, LLMPolicyRequestContext, LLMPolicyResponseContext } from './types';

/**
 * 当我们确实无法从 reasoning_details 中提取到真实 thoughtSignature 时的兜底值。
 *
 * 注意：这不是“推荐做法”，只是最后一道防线，用于避免某些边界情况下直接 400。
 * 真正可靠的方式仍是：正确保存并原样回放 reasoning_details。
 */
const DUMMY_SIGNATURE = 'context_engineering_is_the_way_to_go';

function isRecord(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasToolCallsMessage(m: any): boolean {
  return !!m && typeof m === 'object' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

function hasNonEmptyReasoningDetails(m: any): boolean {
  return !!m && Array.isArray(m.reasoning_details) && m.reasoning_details.length > 0;
}

function extractThoughtSignatureFromReasoningDetails(reasoningDetails: unknown[]): string | undefined {
  const seen = new Set<string>();
  let first: string | undefined;

  const visit = (v: unknown) => {
    if (!v || first) return;
    if (Array.isArray(v)) {
      for (const it of v) visit(it);
      return;
    }
    if (!isRecord(v)) return;
    for (const [k, val] of Object.entries(v)) {
      if (k === 'thoughtSignature' || k === 'thought_signature') {
        if (typeof val === 'string' && val.trim()) {
          const sig = val.trim();
          if (!seen.has(sig)) {
            seen.add(sig);
            first = sig;
            return;
          }
        }
      } else {
        visit(val);
      }
    }
  };

  visit(reasoningDetails);
  return first;
}

function ensureFirstToolCallHasSignature(toolCalls: unknown[], reasoningDetails?: unknown[]): unknown[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return toolCalls;

  // 尝试从 reasoningDetails 提取
  const extracted =
    Array.isArray(reasoningDetails) && reasoningDetails.length > 0
      ? extractThoughtSignatureFromReasoningDetails(reasoningDetails)
      : undefined;

  const sig = (extracted && extracted.trim()) ? extracted.trim() : DUMMY_SIGNATURE;

  // 策略升级：给所有 tool_calls 都打上签名，防止上游校验某个特定位置的 call
  // 同时打印日志方便排查
  const patchedToolCalls = toolCalls.map((tc, index) => {
    if (!isRecord(tc)) return tc;
    
    // 如果原本就有签名且有效，保留
    const existing = tc?.extra_content?.google?.thought_signature;
    if (typeof existing === 'string' && existing.trim()) return tc;

    // 否则注入
    return {
      ...tc,
      extra_content: {
        ...(tc.extra_content || {}),
        google: {
          ...((tc.extra_content || {}).google || {}),
          thought_signature: sig
        }
      }
    };
  });

  return patchedToolCalls;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyContent(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content;
  if (content === null || content === undefined) return undefined;
  if (Array.isArray(content) || isRecord(content)) return stringifyJson(content);
  return String(content);
}

function stringifyToolCall(tc: unknown, index: number): string {
  if (!isRecord(tc)) {
    return `Tool call ${index + 1}: ${stringifyJson(tc)}`;
  }

  const fn = isRecord(tc.function) ? tc.function : undefined;
  const name = typeof fn?.name === 'string' && fn.name.trim() ? fn.name : `tool_${index + 1}`;
  const args = typeof fn?.arguments === 'string' && fn.arguments.trim() ? fn.arguments : '{}';
  return `Tool call ${name} args=${args}`;
}

function degradeAssistantToolCallMessage(message: any): any {
  const preservedContent = stringifyContent(message.content);
  const toolCallContent = Array.isArray(message.tool_calls)
    ? message.tool_calls
      .map((toolCall: unknown, index: number) => stringifyToolCall(toolCall, index))
      .join('\n')
    : '';
  const content = [preservedContent, toolCallContent].filter(Boolean).join('\n\n') || 'Tool interaction degraded to plain text.';
  const { tool_calls: _toolCalls, reasoning_details: _reasoningDetails, ...rest } = message;
  return {
    ...rest,
    role: 'assistant',
    content,
  };
}

function degradeToolResultMessage(message: any): any {
  const content = stringifyContent(message.content) ?? 'Tool result omitted.';
  const prefix =
    typeof message.tool_call_id === 'string' && message.tool_call_id.trim()
      ? `Tool result ${message.tool_call_id}: `
      : 'Tool result: ';
  const { tool_call_id: _toolCallId, name: _name, ...rest } = message;
  return {
    ...rest,
    role: 'assistant',
    content: `${prefix}${content}`,
  };
}

function collectToolCallIds(message: any): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(message?.tool_calls)) return ids;
  for (const toolCall of message.tool_calls) {
    if (isRecord(toolCall) && typeof toolCall.id === 'string' && toolCall.id.trim()) {
      ids.add(toolCall.id);
    }
  }
  return ids;
}

function patchMessages(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages;

  const patchedMessages: any[] = [];
  let degradedToolCallIds: Set<string> | null = null;

  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      patchedMessages.push(m);
      degradedToolCallIds = null;
      continue;
    }

    const role = String((m as any).role || '').toLowerCase();

    if (
      degradedToolCallIds &&
      role === 'tool' &&
      typeof (m as any).tool_call_id === 'string' &&
      degradedToolCallIds.has((m as any).tool_call_id)
    ) {
      patchedMessages.push(degradeToolResultMessage(m));
      continue;
    }

    degradedToolCallIds = null;

    // 仅处理包含 tool_calls 的历史块
    if (!Array.isArray((m as any).tool_calls) || (m as any).tool_calls.length === 0) {
      patchedMessages.push(m);
      continue;
    }

    if (role && role !== 'assistant' && role !== 'model') {
      patchedMessages.push(m);
      continue;
    }

    const reasoningDetails = Array.isArray((m as any).reasoning_details) ? (m as any).reasoning_details : undefined;

    if (!hasNonEmptyReasoningDetails(m)) {
      degradedToolCallIds = collectToolCallIds(m);
      patchedMessages.push(degradeAssistantToolCallMessage(m));
      continue;
    }

    const patchedToolCalls = ensureFirstToolCallHasSignature(m.tool_calls, reasoningDetails);
    const normalizedRole = role === 'model' || !role ? 'assistant' : (m as any).role;
    patchedMessages.push({ ...m, role: normalizedRole, tool_calls: patchedToolCalls });
  }

  return patchedMessages;
}

function patchResponseToolCallsIfNeeded(responseData: any): any {
  // 尽量只做“补齐”，不改变结构
  const msg = responseData?.choices?.[0]?.message;
  if (!msg) return responseData;
  if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) return responseData;

  const reasoningDetails = Array.isArray(msg.reasoning_details) ? msg.reasoning_details : undefined;
  const patched = ensureFirstToolCallHasSignature(msg.tool_calls, reasoningDetails);
  if (patched === msg.tool_calls) return responseData;

  const newMsg = { ...msg, tool_calls: patched };
  const newChoices = [...(responseData.choices || [])];
  newChoices[0] = { ...newChoices[0], message: newMsg };
  return { ...responseData, choices: newChoices };
}

export const openrouterGeminiPolicy: LLMPolicy = {
  name: 'openrouter-gemini-policy',
  match(ctx: LLMPolicyMatchContext): boolean {
    const model = String(ctx.requestModelName || ctx.modelId || '').toLowerCase();
    // 放宽限制：不仅匹配 OpenRouter，也匹配 KouriChat 等所有通过 OpenAI 兼容接口调用 Gemini 的场景
    // 核心特征是：模型名包含 gemini
    return model.includes('gemini');
  },

  beforeRequest(ctx: LLMPolicyRequestContext) {
    const req = ctx.requestData || {};
    if (!Array.isArray(req.messages)) return {};
    const patchedMessages = patchMessages(req.messages);

    // OpenRouter：不要排除 reasoning（否则拿不到 reasoning_details，就无法满足 preserving reasoning blocks）
    // - 不覆盖用户显式传入的 reasoning / include_reasoning
    // - 但如果用户显式 exclude=true，我们仍会强制纠正为 false（Gemini tool calling 否则必炸）
    let reasoning = (req as any).reasoning;
    if (reasoning === undefined && (req as any).include_reasoning === undefined) {
      reasoning = { enabled: true, exclude: false };
    } else if (isRecord(reasoning) && reasoning.exclude === true) {
      reasoning = { ...reasoning, exclude: false };
    }

    const nextReq: any = { ...req, messages: patchedMessages };
    if (reasoning !== undefined) nextReq.reasoning = reasoning;
    return { requestData: nextReq };
  },

  afterResponse(ctx: LLMPolicyResponseContext) {
    return { responseData: patchResponseToolCallsIfNeeded(ctx.responseData) };
  },

  onError(error: Error): { action: 'switch_model'; reason: string } | { action: 'none' } {
    const msg = (error?.message || '').toLowerCase();
    if (
      msg.includes('missing a `thought_signature`') ||
      msg.includes('missing a thought_signature') ||
      msg.includes('reasoning details to be preserved') ||
      msg.includes('preserving-reasoning-blocks') ||
      msg.includes('reasoning_details')
    ) {
      // 交给主链路做“切换备用模型”
      return { action: 'switch_model', reason: 'thought_signature/reasoning_details validation failed' };
    }
    return { action: 'none' };
  }
};
