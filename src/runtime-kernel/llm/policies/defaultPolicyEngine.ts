/**
 * @file src/agent/runtime-kernel/llm/policies/defaultPolicyEngine.ts
 *
 * @description
 * 默认 PolicyEngine（集中注册当前项目支持的 provider/model 策略）。
 */

import { LLMPolicyEngine } from './policyEngine';
import { openrouterGeminiPolicy } from './openrouterGeminiPolicy';
import { openrouterLocationPolicy } from './openrouterLocationPolicy';
import { moonshotKimiPolicy } from './moonshotKimiPolicy';

export const defaultPolicyEngine = new LLMPolicyEngine([
  openrouterLocationPolicy,
  openrouterGeminiPolicy,
  moonshotKimiPolicy
]);
