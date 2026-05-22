type UnknownRecord = Record<string, unknown>;

const mergeableTextFields = ['reasoning_content'] as const;

type MergeableTextField = (typeof mergeableTextFields)[number];

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function findMergeableTextField(detail: unknown): MergeableTextField | undefined {
  if (!isRecord(detail)) return undefined;
  if (typeof detail.provider !== 'string') return undefined;
  if (typeof detail.type !== 'string') return undefined;

  for (const field of mergeableTextFields) {
    if (typeof detail[field] === 'string') {
      return field;
    }
  }
  return undefined;
}

function hasOnlyStableTextDetailFields(detail: UnknownRecord, textField: MergeableTextField): boolean {
  const allowedKeys = new Set<string>(['provider', 'type', textField]);
  return Object.keys(detail).every((key) => allowedKeys.has(key));
}

function canMergeTextDetails(previous: unknown, incoming: unknown): previous is UnknownRecord {
  if (!isRecord(previous) || !isRecord(incoming)) return false;

  const previousField = findMergeableTextField(previous);
  const incomingField = findMergeableTextField(incoming);
  if (!previousField || previousField !== incomingField) return false;

  return previous.provider === incoming.provider
    && previous.type === incoming.type
    && hasOnlyStableTextDetailFields(previous, previousField)
    && hasOnlyStableTextDetailFields(incoming, incomingField);
}

function mergeStreamingText(previous: string, incoming: string): string {
  if (!previous) return incoming;
  if (!incoming) return previous;

  // provider 可能按 delta 发，也可能按 snapshot 发。这里只归并“同 provider/type 的纯文本 sidecar”，
  // 带签名、索引等私有元数据的 detail 保持原样，避免破坏 replay 契约。
  if (incoming.startsWith(previous)) {
    return incoming;
  }
  if (previous.endsWith(incoming)) {
    return previous;
  }
  return `${previous}${incoming}`;
}

export function appendStreamingProviderReasoningDetails(existing: unknown[], incoming: unknown[]): unknown[] {
  const next = [...existing];

  for (const detail of incoming) {
    const previous = next[next.length - 1];
    if (canMergeTextDetails(previous, detail)) {
      const textField = findMergeableTextField(previous);
      if (textField && isRecord(detail)) {
        const mergedText = mergeStreamingText(String(previous[textField]), String(detail[textField]));
        if (mergedText === previous[textField]) {
          continue;
        }
        next[next.length - 1] = {
          ...previous,
          [textField]: mergedText,
        };
        continue;
      }
    }
    next.push(detail);
  }

  return next;
}

export function compactProviderReasoningDetails(reasoningDetails: unknown[]): unknown[] {
  return appendStreamingProviderReasoningDetails([], reasoningDetails);
}

export function compactReasoningDetailsInValue<T>(value: T): T {
  return compactValue(value) as T;
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactValue(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  const compacted: UnknownRecord = {};
  for (const [key, childValue] of Object.entries(value)) {
    if (key === 'reasoning_details' && Array.isArray(childValue)) {
      compacted[key] = compactProviderReasoningDetails(childValue);
      continue;
    }
    compacted[key] = compactValue(childValue);
  }
  return compacted;
}
