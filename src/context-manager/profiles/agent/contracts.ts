/**
 * @file src/agent/context-manager/profiles/agent/contracts.ts
 */

import type { AiMessage } from '../../../contracts';
import type { FenceInjection } from '../../shared/fences';

/**
 * Minimal request contract used by package-neutral agent profile code.
 * Product-specific invoke requests can extend this shape.
 */
export interface AgentProfileRequest {
  query: string;
  promptKey: string;
  model_id?: string;
  modelId?: string;
  availableTools?: string[];
  conversationHistory?: AiMessage[];
  fences?: FenceInjection[];
}
