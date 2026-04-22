/**
 * @file src/agent/runtime-kernel/llm/policies/openrouterLocationPolicy.ts
 *
 * @description
 * OpenRouter 路由到某些上游（如 Google AI Studio）时可能触发地域限制，
 * 典型报错：User location is not supported / FAILED_PRECONDITION。
 *
 * 这类错误“重试同一路由”通常无意义，应尽快切换备用模型/线路。
 */

import type { LLMPolicy, LLMPolicyMatchContext } from './types';

export const openrouterLocationPolicy: LLMPolicy = {
  name: 'openrouter-location-policy',
  match(ctx: LLMPolicyMatchContext): boolean {
    const base = String(ctx.apiBase || '').toLowerCase();
    return base.includes('openrouter.ai');
  },
  onError(error: Error): { action: 'switch_model'; reason: string } | { action: 'none' } {
    const msg = (error?.message || '').toLowerCase();
    if (
      msg.includes('user location is not supported') ||
      msg.includes('location is not supported') ||
      msg.includes('failed_precondition') ||
      msg.includes('failed precondition') ||
      msg.includes('not available in your region') ||
      msg.includes('not available in your country')
    ) {
      return { action: 'switch_model', reason: 'upstream location restriction' };
    }
    return { action: 'none' };
  }
};

