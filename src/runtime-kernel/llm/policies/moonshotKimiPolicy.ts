/**
 * @file src/agent/runtime-kernel/llm/policies/moonshotKimiPolicy.ts
 *
 * @description
 * Moonshot Kimi（尤其是 kimi-k2-thinking / kimi-k2.5 thinking）兼容策略：
 *
 * 关键协议点（官方文档）：
 * - 思考内容使用 `reasoning_content` 字段承载（与 `content` 同级）。
 * - 在多步工具调用中，若本轮 assistant(tool_calls) 缺少必须回放的 reasoning_content，上游会报错。
 *
 * 本 policy 的目标：
 * - 把历史中常见的 `<think>...</think>`（我们内部遗留格式）转换为 Kimi 需要的 `reasoning_content`；
 * - 对 tool_calls 轮次做“同轮回填”：若 assistant(tool_calls) 缺 reasoning_content，则从紧邻的上一条 assistant 的思考中回填；
 *
 * 注意：
 * - 这里是“协议适配”，不是内容修复；不编造思考内容。
 * - 仅在出站请求里做转换，不影响持久化历史结构。
 */

import type { LLMPolicy, LLMPolicyMatchContext, LLMPolicyRequestContext } from './types';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isKimiModelName(name: unknown): boolean {
  const s = typeof name === 'string' ? name.toLowerCase() : '';
  if (!s) return false;
  return s.includes('kimi');
}

function extractThinkTag(content: string): { reasoning?: string; contentWithoutThink: string } {
  // 只提取第一段 <think>...</think>，并从 content 中剥离（保留最终回答部分）
  const re = /<think>([\s\S]*?)<\/think>/i;
  const m = content.match(re);
  if (!m) return { contentWithoutThink: content };
  const reasoning = (m[1] || '').trim();
  const contentWithoutThink = content.replace(re, '');
  return { reasoning: reasoning || undefined, contentWithoutThink };
}

function hasToolCalls(msg: Record<string, unknown>): boolean {
  const tc = msg['tool_calls'];
  return Array.isArray(tc) && tc.length > 0;
}

function patchMessages(messages: unknown[]): unknown[] {
  const out: unknown[] = [];

  // 用于“同轮回填”的最近一次 reasoning_content
  let lastAssistantReasoning: string | undefined = undefined;

  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!isRecord(m)) {
      out.push(m);
      continue;
    }

    const role = typeof m['role'] === 'string' ? String(m['role']).toLowerCase() : '';
    const isAssistantLike = role === 'assistant' || role === 'model' || (!role && hasToolCalls(m));
    if (!isAssistantLike) {
      out.push(m);
      continue;
    }

    const nextMsg: Record<string, unknown> = { ...m };

    // 1) 先识别/提取思考内容：优先使用现成的 reasoning_content，否则从 <think> 标签里抽取
    const existingReasoning = typeof nextMsg['reasoning_content'] === 'string' ? nextMsg['reasoning_content'].trim() : '';
    if (existingReasoning) {
      lastAssistantReasoning = existingReasoning;
    } else {
      const rawContent = nextMsg['content'];
      if (typeof rawContent === 'string' && rawContent.includes('<think>')) {
        const { reasoning, contentWithoutThink } = extractThinkTag(rawContent);
        if (reasoning) {
          nextMsg['reasoning_content'] = reasoning;
          lastAssistantReasoning = reasoning;
        }
        // content 去掉 <think> 后保留答案部分（可能为空字符串）
        nextMsg['content'] = contentWithoutThink;
      }
    }

    // 2) Kimi tool_calls 校验：assistant(tool_calls) 必须带 reasoning_content（若本轮存在）
    if (hasToolCalls(nextMsg)) {
      const rc = typeof nextMsg['reasoning_content'] === 'string' ? nextMsg['reasoning_content'].trim() : '';
      if (!rc && lastAssistantReasoning) {
        nextMsg['reasoning_content'] = lastAssistantReasoning;
      }
    }

    // 3) role 归一化：OpenAI-compat 只接受 assistant
    if (role === 'model' || !role) {
      nextMsg['role'] = 'assistant';
    }

    out.push(nextMsg);
  }

  return out;
}

export const moonshotKimiPolicy: LLMPolicy = {
  name: 'moonshot-kimi-policy',
  match(ctx: LLMPolicyMatchContext): boolean {
    // 以 modelName 为主：Kimi 也可能通过不同 api_base 走 OpenAI-compat
    return isKimiModelName(ctx.requestModelName || ctx.modelId);
  },

  beforeRequest(ctx: LLMPolicyRequestContext) {
    const req = ctx.requestData || {};
    if (!isRecord(req)) return {};
    const messages = req['messages'];
    if (!Array.isArray(messages)) return {};

    return {
      requestData: {
        ...req,
        messages: patchMessages(messages),
      }
    };
  }
};
