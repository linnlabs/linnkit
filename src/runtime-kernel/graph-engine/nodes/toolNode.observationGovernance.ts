import type {
  ObservationPreviewContext,
  ObservationPreviewMeta,
  ObservationPreviewPort,
} from '../../tools/ports';
import { isRecord, readString } from './toolNode.helpers';

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
    maxChars: 10_000,
    maxLines: 800,
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
