import { resolveEffectivePromptBudget, type EffectivePromptBudget } from './resolveEffectivePromptBudget';
import type { ModelCatalogEntry } from '../../llm/modelCatalog';

/** fallback 复用当前 Prompt 与已决定的输出量，但不能借用主模型更大的物理窗口。 */
export function resolveFallbackPromptBudget(
  primaryBudget: EffectivePromptBudget,
  requiredOutputLimitTokens: number,
  route: ModelCatalogEntry['inference_route'],
): EffectivePromptBudget {
  if (!route) throw new Error('Fallback 模型缺少正式 inference route。');
  const budget = resolveEffectivePromptBudget({
    policyMaxTokens: primaryBudget.effectiveWindowTokens,
    policyReservedForResponse: requiredOutputLimitTokens,
    modelContextWindowTokens: route.context_window_tokens,
    modelMaxOutputTokens: route.max_output_tokens,
    toolDefinitionTokens: primaryBudget.toolDefinitionTokens,
  });
  const inputBudgetTokens = Math.min(primaryBudget.inputBudgetTokens, budget.inputBudgetTokens);
  return {
    ...budget,
    inputBudgetTokens,
    messageBudgetTokens: inputBudgetTokens - budget.toolDefinitionTokens,
  };
}
