/**
 * @file src/agent/runtime-kernel/llm/policies/policyEngine.ts
 *
 * @description
 * 统一的 LLM Policy Engine：
 * - 按 match 条件筛选 policies
 * - 固定调用点：beforeRequest / afterResponse / onError
 *
 * 主链路通过调用 PolicyEngine 达到“可扩展但不膨胀”的效果。
 */

import type {
  LLMPolicy,
  LLMPolicyMatchContext,
  LLMPolicyRequestContext,
  LLMPolicyResponseContext,
  LLMPolicyErrorDecision
} from './types';

export class LLMPolicyEngine {
  private readonly policies: LLMPolicy[];

  constructor(policies: LLMPolicy[]) {
    this.policies = Array.isArray(policies) ? policies : [];
  }

  private matched(ctx: LLMPolicyMatchContext): LLMPolicy[] {
    return this.policies.filter(p => {
      try {
        return p.match(ctx);
      } catch {
        return false;
      }
    });
  }

  applyBeforeRequest(ctx: LLMPolicyRequestContext): { requestData: unknown; headers?: Record<string, string> } {
    const matched = this.matched(ctx);
    let requestData = ctx.requestData;
    let headers = ctx.headers;

    for (const p of matched) {
      if (!p.beforeRequest) continue;
      try {
        const out = p.beforeRequest({ ...ctx, requestData, headers });
        if (out?.requestData !== undefined) requestData = out.requestData;
        if (out?.headers !== undefined) headers = out.headers;
      } catch {
        // policy 不应影响主流程
      }
    }

    return { requestData, headers };
  }

  applyAfterResponse(ctx: LLMPolicyResponseContext): { responseData: unknown } {
    const matched = this.matched(ctx);
    let responseData = ctx.responseData;
    for (const p of matched) {
      if (!p.afterResponse) continue;
      try {
        const out = p.afterResponse({ ...ctx, responseData });
        if (out?.responseData !== undefined) responseData = out.responseData;
      } catch {
        // ignore
      }
    }
    return { responseData };
  }

  decideOnError(error: Error, ctx: LLMPolicyMatchContext): LLMPolicyErrorDecision {
    const matched = this.matched(ctx);
    for (const p of matched) {
      if (!p.onError) continue;
      try {
        const decision = p.onError(error, ctx);
        if (decision && decision.action !== 'none') return decision;
      } catch {
        // ignore
      }
    }
    return { action: 'none' };
  }
}
