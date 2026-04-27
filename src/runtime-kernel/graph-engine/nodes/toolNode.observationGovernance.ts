import type {
  ObservationPreviewContext,
  ObservationPreviewMeta,
  ObservationPreviewPort,
} from '../../tools/ports';
import { isRecord, readString } from './toolNode.helpers';

export const TOOL_OBSERVATION_PREVIEW_LIMITS = {
  /**
   * 执行期 observation 预览阈值。
   *
   * 中文说明：
   * - 这里控制“工具刚执行完后，原始 observation 多长就落盘到 ToolOutputStore”；
   * - 这是执行期的网络/持久化/实时回放保护，不替代 context-manager 的 `MAX_TOOL_PAIR_TOKENS`；
   * - `MAX_TOOL_PAIR_TOKENS` 仍负责下一轮构建 LLM 上下文时，对整组 tool_calls + tool_output 做 token 预算兜底。
   */
  maxChars: 20_000,
  maxLines: 1_200,
} as const;

function buildToolOutputUiMeta(params: {
  toolName: string;
  parsed: Record<string, unknown>;
}): ObservationPreviewMeta | undefined {
  const data = params.parsed['data'];
  if (!isRecord(data)) {
    return undefined;
  }

  if (params.toolName === 'browse_document_by_chunk' || params.toolName === 'browse_document_content') {
    const filename = readString(data['filename']);
    return filename ? { filename } : undefined;
  }

  if (params.toolName === 'sharedmemory_read') {
    const docName = readString(data['doc_name']);
    return docName ? { doc_name: docName } : undefined;
  }

  if (params.toolName === 'resource_read') {
    const uri = readString(data['uri']);
    if (typeof uri === 'string' && uri.startsWith('shared_memory://docs/')) {
      const docName = readString(data['doc_name']);
      return docName ? { doc_name: docName } : undefined;
    }
    if (typeof uri === 'string' && (uri.startsWith('evidence://') || uri.startsWith('citation_snapshot://'))) {
      const bundleId = readString(data['bundle_id']);
      return bundleId ? { document_name: bundleId } : undefined;
    }
  }

  if (params.toolName === 'workspace_read_documents') {
    const documentName = readString(data['documentName']) ?? readString(data['document_name']);
    const docTypeRaw = readString(data['docType']) ?? readString(data['doc_type']);
    const doc_type = docTypeRaw === 'markdown' || docTypeRaw === 'mindmap' ? docTypeRaw : undefined;
    if (!documentName && !doc_type) {
      return undefined;
    }
    return {
      ...(documentName ? { document_name: documentName } : {}),
      ...(doc_type ? { doc_type } : {}),
    };
  }

  return undefined;
}

export async function applyObservationGovernance(params: {
  parsed: unknown;
  toolName: string;
  toolContext: ObservationPreviewContext;
  structuredObservation: string | undefined;
  observationPreview: ObservationPreviewPort;
}): Promise<void> {
  if (!params.structuredObservation || !isRecord(params.parsed)) {
    return;
  }

  const truncated = await params.observationPreview.truncateObservation({
    context: params.toolContext,
    toolName: params.toolName,
    text: params.structuredObservation,
    maxChars: TOOL_OBSERVATION_PREVIEW_LIMITS.maxChars,
    maxLines: TOOL_OBSERVATION_PREVIEW_LIMITS.maxLines,
    meta: buildToolOutputUiMeta({
      toolName: params.toolName,
      parsed: params.parsed,
    }),
  });

  if (!truncated.truncated) {
    return;
  }

  params.parsed['observation'] = truncated.preview;
  const data = params.parsed['data'];
  if (isRecord(data) && !('tool_output_store' in data)) {
    data['tool_output_store'] = { blob_id: truncated.blob_id };
  }
}
