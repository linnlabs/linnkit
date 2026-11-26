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

/**
 * 去掉已结算的调用，其余保持原顺序。
 *
 * 串行时它总是第一个；并行组里结算顺序不定，所以按身份移除而不是 slice(1)。
 * 同一批出现重复 ID 时只移除第一个，与串行 slice(1) 一致。
 */
export function withoutToolCall<T extends { readonly id: string }>(
  calls: readonly T[],
  callId: string,
): T[] {
  const index = calls.findIndex(call => call.id === callId);
  return index < 0 ? [...calls] : [...calls.slice(0, index), ...calls.slice(index + 1)];
}
