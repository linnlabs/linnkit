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
  | { truncated: true; preview: string; blob_id: string };

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
