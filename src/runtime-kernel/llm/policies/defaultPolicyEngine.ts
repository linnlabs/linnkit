/**
 * @file src/agent/runtime-kernel/llm/policies/defaultPolicyEngine.ts
 *
 * @description
 * linnkit 的默认 PolicyEngine 不注册任何 provider/model 策略。
 *
 * provider 适配属于宿主集成层职责。宿主可以复用 `LLMPolicyEngine`
 * 并显式注入自己的 policies。
 */

import { LLMPolicyEngine } from './policyEngine';

export const defaultPolicyEngine = new LLMPolicyEngine([]);
