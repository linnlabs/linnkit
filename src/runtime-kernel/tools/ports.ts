import type { ToolDisplayOptions } from './ui-types';
import type { ToolExecutionContext } from './toolExecutionContext';
import type { ToolSchemaContext } from './toolSchemaContext';
import type { ConversationArtifactContext } from './conversationArtifactContext';
import type {
  OpenAIToolSchema,
  ToolArgs,
  ToolParameterSchema,
} from './toolContracts';
import type { ToolIdempotencyPolicy } from './idempotency/toolIdempotency';

export interface ToolRuntimeDefinition {
  parameters: ToolParameterSchema;
  displayOptions?: ToolDisplayOptions;
  idempotency?: ToolIdempotencyPolicy;
}

export interface ToolExecutionResult {
  success: boolean;
  result?: string;
  error?: string;
  errorKind?: 'protocol' | 'execution';
  durationMs: number;
  idempotency?: { key: string; cacheHit: boolean };
}

export interface ObservationPreviewMeta {
  filename?: string;
  doc_name?: string;
  document_name?: string;
  doc_type?: 'markdown' | 'mindmap';
}

export type ObservationPreviewContext = ToolExecutionContext & ConversationArtifactContext;

export type ObservationPreviewResult =
  | { truncated: false; preview: string }
  | {
      truncated: true;
      preview: string;
      blob_id: string;
      originalChars?: number;
      previewChars?: number;
      originalLines?: number;
      previewLines?: number;
    };

export interface ToolCatalogPort {
  getToolSchemas(toolNames?: string[], baseContext?: ToolSchemaContext): OpenAIToolSchema[];
  getToolDefinition(toolName: string): ToolRuntimeDefinition | undefined;
}

export interface ToolPresentationPort {
  getDisplayOptions(toolName: string): ToolDisplayOptions | undefined;
}

export interface ToolExecutionPort {
  executeTool(
    toolName: string,
    args: ToolArgs,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export interface ObservationPreviewPort {
  /**
   * 执行期 observation 预览/落盘治理。
   *
   * 中文说明：
   * - framework 只把 `maxChars/maxLines` 和工具上下文传给 host；
   * - 完整内容写到本地目录、对象存储还是数据库，由 host 的这个 port 决定；
   * - 如果返回 `blob_id`，host 需要保证对应读取工具使用同一个 store。
   */
  truncateObservation(params: {
    context: ObservationPreviewContext;
    toolName: string;
    text: string;
    maxChars: number;
    maxLines: number;
    meta?: ObservationPreviewMeta;
  }): Promise<ObservationPreviewResult>;
}

export interface ToolRuntimePort extends ToolCatalogPort, ToolPresentationPort, ToolExecutionPort {}
