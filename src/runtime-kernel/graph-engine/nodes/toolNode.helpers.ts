import type { RuntimeEvent } from '../../../contracts';

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseJsonSafe(input: unknown): unknown {
  if (typeof input !== 'string' || input.length === 0) {
    return null;
  }
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function computeCitationOffset(history: RuntimeEvent[], turnId: string): number {
  let citationOffset = 0;

  for (const event of history) {
    if (event.turn_id !== turnId || event.type !== 'tool_output') {
      continue;
    }

    const payload = isRecord(event.payload) ? event.payload : undefined;
    const result = payload && isRecord(payload.result) ? payload.result : undefined;
    const data = result && isRecord(result.data) ? result.data : undefined;
    const citationsMetadata = data && isRecord(data.citations) ? data.citations : undefined;
    const citations = citationsMetadata?.citations;

    if (Array.isArray(citations)) {
      citationOffset += citations.length;
    }
  }

  return citationOffset;
}

