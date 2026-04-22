/**
 * @file src/agent/runtime-kernel/llm/modelCatalog.ts
 *
 * @description
 * Agent runtime 对“模型目录”的最小协议定义。
 * runtime-kernel 只依赖这些查询能力，不直接依赖 app 的 model-registry 实现。
 */

export interface ModelCatalogEntry {
  id: string;
  enabled?: boolean;
  api_key?: string;
  api_base?: string;
  billing_mode?: 'byok' | 'cloud';
  /**
   * 是否允许客户端侧重试。
   *
   * 说明：
   * - runtime-kernel 会基于该字段与 billing_mode 决定重试策略；
   * - 该字段来自上层 model-registry（对齐 `src/model-registry/contracts.ts`），避免在 runtime 侧出现类型漂移。
   */
  enable_client_retry?: boolean;
  model_name?: string;
  provider?: string;
  capabilities?: readonly string[];
  ui_visibility?: readonly string[];
}

export interface ModelCatalogLike {
  getModelById(id: string): ModelCatalogEntry | undefined;
  getModelsByCapability(capability: string): ModelCatalogEntry[];
  getModelsByUIVisibility(visibility: string): ModelCatalogEntry[];
}

export function createEmptyModelCatalog(): ModelCatalogLike {
  return {
    getModelById(): ModelCatalogEntry | undefined {
      return undefined;
    },
    getModelsByCapability(): ModelCatalogEntry[] {
      return [];
    },
    getModelsByUIVisibility(): ModelCatalogEntry[] {
      return [];
    },
  };
}
