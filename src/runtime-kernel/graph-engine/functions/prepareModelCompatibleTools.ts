import type { ModelCatalogEntry } from '../../llm/modelCatalog';
import {
  EMPTY_MODEL_INPUT_REQUIREMENT,
  evaluateModelInputCompatibility,
  mergeModelInputRequirements,
  type ModelInputRequirement,
} from '../../llm/input-capabilities';
import type { OpenAIToolSchema } from '../../tools/toolContracts';
import type { ToolRuntimeDefinition } from '../../tools/ports';

export interface ModelCompatibleToolPreparation {
  readonly schemas: readonly OpenAIToolSchema[];
  readonly requirement: ModelInputRequirement;
}

/**
 * 只过滤带静态 requirement 的工具；动态工具必须等真实结果出现 selection 后再判定。
 */
export function prepareModelCompatibleTools(input: {
  readonly schemas: readonly OpenAIToolSchema[];
  readonly model: ModelCatalogEntry | undefined;
  readonly getToolDefinition: (toolName: string) => ToolRuntimeDefinition | undefined;
}): ModelCompatibleToolPreparation {
  const schemas: OpenAIToolSchema[] = [];
  const requirements: ModelInputRequirement[] = [];

  for (const schema of input.schemas) {
    const requirement = input.getToolDefinition(schema.function.name)?.modelInputRequirement;
    if (requirement && !evaluateModelInputCompatibility(input.model, requirement).compatible) {
      continue;
    }
    schemas.push(schema);
    if (requirement) {
      requirements.push(requirement);
    }
  }

  return {
    schemas: Object.freeze(schemas),
    requirement: requirements.length > 0
      ? mergeModelInputRequirements(...requirements)
      : EMPTY_MODEL_INPUT_REQUIREMENT,
  };
}
