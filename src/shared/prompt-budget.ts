export const DEFAULT_PROMPT_CONTEXT_WINDOW_TOKENS = 256_000;
export const DEFAULT_PROMPT_MAX_OUTPUT_TOKENS = 16_384;

export interface ResolveEffectivePromptBudgetInput {
  policyMaxTokens?: number;
  policyReservedForResponse?: number;
  modelContextWindowTokens?: number;
  modelMaxOutputTokens?: number;
  fallbackContextWindowTokens?: number;
  fallbackMaxOutputTokens?: number;
  toolDefinitionTokens: number;
}

export interface EffectivePromptBudget {
  effectiveWindowTokens: number;
  /** 构建期的输出能力/策略上限；最终请求还须按实际 Prompt 占用收窄。 */
  outputLimitTokens: number;
  inputBudgetTokens: number;
  toolDefinitionTokens: number;
  messageBudgetTokens: number;
}

/**
 * 统一解析一次 LLM 调用的有效 Prompt 预算。
 *
 * 模型输出能力不是必须预留的空间。只有显式响应 policy（或无 route 的独立 host
 * fallback）才预留固定响应预算；其余情况为生成至少保留一个 token，最终计量后
 * 再收窄实际输出上限。prepared tools 必须先于 messages 占用输入预算。
 * 该纯函数位于 framework shared 层，让 Context Manager 与 Graph inference 使用同一个数学 owner。
 */
export function resolveEffectivePromptBudget(
  input: ResolveEffectivePromptBudgetInput,
): EffectivePromptBudget {
  assertOptionalPositiveSafeInteger(input.policyMaxTokens, 'policyMaxTokens');
  assertOptionalPositiveSafeInteger(
    input.policyReservedForResponse,
    'policyReservedForResponse',
  );
  assertOptionalPositiveSafeInteger(
    input.modelContextWindowTokens,
    'modelContextWindowTokens',
  );
  assertOptionalPositiveSafeInteger(input.modelMaxOutputTokens, 'modelMaxOutputTokens');
  assertOptionalPositiveSafeInteger(
    input.fallbackContextWindowTokens,
    'fallbackContextWindowTokens',
  );
  assertOptionalPositiveSafeInteger(
    input.fallbackMaxOutputTokens,
    'fallbackMaxOutputTokens',
  );
  assertNonNegativeSafeInteger(input.toolDefinitionTokens, 'toolDefinitionTokens');

  const modelContextWindowTokens = input.modelContextWindowTokens
    ?? input.fallbackContextWindowTokens
    ?? DEFAULT_PROMPT_CONTEXT_WINDOW_TOKENS;
  const modelMaxOutputTokens = input.modelMaxOutputTokens
    ?? input.fallbackMaxOutputTokens
    ?? DEFAULT_PROMPT_MAX_OUTPUT_TOKENS;
  const effectiveWindowTokens = input.policyMaxTokens === undefined
    ? modelContextWindowTokens
    : Math.min(input.policyMaxTokens, modelContextWindowTokens);
  const outputLimitTokens = input.policyReservedForResponse === undefined
    ? modelMaxOutputTokens
    : Math.min(input.policyReservedForResponse, modelMaxOutputTokens);
  const responseReservationTokens = input.policyReservedForResponse !== undefined
    || input.modelContextWindowTokens === undefined
    ? outputLimitTokens
    : 1;
  const inputBudgetTokens = effectiveWindowTokens - responseReservationTokens;
  if (inputBudgetTokens < 1) {
    throw new Error(
      '有效模型窗口必须大于输出预留，才能形成正数 Prompt 输入预算。',
    );
  }

  const messageBudgetTokens = inputBudgetTokens - input.toolDefinitionTokens;
  if (messageBudgetTokens < 1) {
    throw new Error(
      'Tool definitions 已占满 Prompt 输入预算，无法为 messages 保留 token。',
    );
  }

  return {
    effectiveWindowTokens,
    outputLimitTokens,
    inputBudgetTokens,
    toolDefinitionTokens: input.toolDefinitionTokens,
    messageBudgetTokens,
  };
}

function assertOptionalPositiveSafeInteger(
  value: number | undefined,
  field: string,
): void {
  if (value !== undefined) {
    assertPositiveSafeInteger(value, field);
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} 必须是正安全整数。`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} 必须是非负安全整数。`);
  }
}
