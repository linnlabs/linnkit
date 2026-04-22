import type { ToolParameterProperty, ToolParameterSchema } from './toolContracts';

type UnknownRecord = Record<string, unknown>;
type NormalizeToolArgsOptions = {
  toolName?: string;
  path?: string;
};

function isRecord(v: unknown): v is UnknownRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function tryParseJsonEncodedValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  if (trimmed.length === 0) return v;
  try {
    return JSON.parse(trimmed);
  } catch {
    return v;
  }
}

function joinPath(basePath: string | undefined, segment: string): string {
  return basePath ? `${basePath}.${segment}` : segment;
}

function logJsonEncodedNormalization(
  expectedType: 'array' | 'object',
  options: NormalizeToolArgsOptions,
): void {
  const toolPrefix = options.toolName ? `${options.toolName}.` : '';
  const path = options.path ?? '<root>';
  console.warn(`[ToolArgNormalizer] Normalized JSON-encoded ${expectedType} string for ${toolPrefix}${path}`);
}

function normalizeBoolean(v: unknown): unknown {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (v === 1) return true;
    if (v === 0) return false;
    return v;
  }
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return v;
}

function normalizeNumber(v: unknown, kind: 'integer' | 'number'): unknown {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (kind === 'integer') return Number.isInteger(v) ? v : v;
    return v;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length === 0) return v;
    const parsed = Number(s);
    if (!Number.isFinite(parsed)) return v;
    if (kind === 'integer') return Number.isInteger(parsed) ? parsed : v;
    return parsed;
  }
  return v;
}

function normalizeByPropertySchema(
  prop: ToolParameterProperty,
  v: unknown,
  options: NormalizeToolArgsOptions,
): unknown {
  switch (prop.type) {
    case 'boolean':
      return normalizeBoolean(v);
    case 'integer':
      return normalizeNumber(v, 'integer');
    case 'number':
      return normalizeNumber(v, 'number');
    case 'string':
      return v;
    case 'array': {
      const parsedValue = tryParseJsonEncodedValue(v);
      if (parsedValue !== v && Array.isArray(parsedValue)) {
        logJsonEncodedNormalization('array', options);
      }
      if (!Array.isArray(parsedValue) || !prop.items) return parsedValue;
      return parsedValue.map((item, index) => normalizeByPropertySchema(
        prop.items!,
        item,
        {
          ...options,
          path: joinPath(options.path, `[${index}]`),
        },
      ));
    }
    case 'object': {
      const parsedValue = tryParseJsonEncodedValue(v);
      if (parsedValue !== v && isRecord(parsedValue)) {
        logJsonEncodedNormalization('object', options);
      }
      if (!isRecord(parsedValue)) return parsedValue;
      if (!prop.properties || !isRecord(prop.properties)) return parsedValue;
      return normalizeToolArgs(
        { type: 'object', properties: prop.properties },
        parsedValue,
        options,
      );
    }
    default:
      return v;
  }
}

export function normalizeToolArgs(
  schema: ToolParameterSchema,
  args: UnknownRecord,
  options: NormalizeToolArgsOptions = {},
): UnknownRecord {
  const next: UnknownRecord = { ...args };

  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue;
    next[key] = normalizeByPropertySchema(prop, next[key], {
      ...options,
      path: joinPath(options.path, key),
    });
  }

  return next;
}
