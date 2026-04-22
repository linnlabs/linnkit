import type { LlmCallOptions } from '../../../llm/caller';
import type { ModelCatalogLike } from '../../../llm/modelCatalog';
import type { ModelResolverLike } from '../../../llm/modelResolver';
import type { ToolCatalogPort } from '../../../tools/ports';
import type { TickPipelineContext, TickStage } from '../types';
import { readNonEmptyString } from '../helpers';

export interface PrepareCallStageDependencies {
  modelResolver: Pick<ModelResolverLike, 'resolveModelId'>;
  modelCatalog: Pick<ModelCatalogLike, 'getModelById'>;
  toolCatalog: Pick<ToolCatalogPort, 'getToolSchemas'>;
  cloudQuotaFallbackModelId?: string;
}

export function createPrepareCallStage(
  dependencies: PrepareCallStageDependencies,
): TickStage {
  return {
    id: 'prepare_call',
    async run(ctx: TickPipelineContext): Promise<void> {
      const lockedRunModelId = readNonEmptyString(ctx.executorLocal?.runLockedModelId);
      const requestedModelId = lockedRunModelId ?? ctx.request.model_id;
      ctx.modelId = dependencies.modelResolver.resolveModelId(requestedModelId);
      ctx.toolSchemas = dependencies.toolCatalog.getToolSchemas(ctx.request.availableTools, {
        imageGenerationModelId: ctx.request.imageGenerationModelId,
      });

      const llmOptions: LlmCallOptions = {};
      if (!ctx.forceFinalAnswer && ctx.request.enableTools !== false && ctx.toolSchemas.length > 0) {
        llmOptions.tools = ctx.toolSchemas;
        if (ctx.executorLocal?.phase === 'force_tools') {
          const firstToolName = ctx.toolSchemas[0]?.function?.name;
          llmOptions.tool_choice =
            typeof firstToolName === 'string' && firstToolName.trim().length > 0
              ? { type: 'function', function: { name: firstToolName.trim() } }
              : 'auto';
        } else {
          llmOptions.tool_choice = 'auto';
        }
      } else {
        llmOptions.tool_choice = 'none';
      }

      const modelConfig = dependencies.modelCatalog.getModelById(ctx.modelId);
      // 云端限额降级仅在 run 内续跑时生效，用户发起的首次 LLM 调用不降级（直接报错）。
      // 判定依据：user(step 1)→llm(step 2) 时 stepCount===2，属于用户发起；
      // 其余场景（tool 后续跑 stepCount>2、checkpoint 重置 stepCount=1、child-run stepCount=1）均为续跑。
      const stepCount = ctx.executorLocal?.stepCount;
      const isRunContinuation = typeof stepCount === 'number' && stepCount !== 2;
      if (
        dependencies.cloudQuotaFallbackModelId &&
        modelConfig?.billing_mode === 'cloud' &&
        ctx.modelId !== dependencies.cloudQuotaFallbackModelId &&
        isRunContinuation
      ) {
        llmOptions.cloud_quota_fallback_model_id = dependencies.cloudQuotaFallbackModelId;
      }

      ctx.llmOptions = llmOptions;
    },
  };
}
