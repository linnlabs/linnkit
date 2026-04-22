import { createHash } from 'crypto';
import type { ToolExecutionContext } from '../toolExecutionContext';
import type { RuntimeEvent } from '../../../contracts';

type UnknownRecord = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export type ToolIdempotencyScope = 'conversation' | 'turn';

export type ToolIdempotencyPolicy = {
  scope: ToolIdempotencyScope;
};

function stableStringify(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'number' || t === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(String(v));
}

function resolveScopeKey(scope: ToolIdempotencyScope, context: ToolExecutionContext): string {
  const ctx = context as unknown as UnknownRecord;
  if (scope === 'conversation') {
    const conversationId = ctx['conversationId'];
    if (typeof conversationId === 'string' && conversationId.trim().length > 0) return conversationId.trim();
  }
  const turnId = ctx['turnId'];
  return typeof turnId === 'string' && turnId.trim().length > 0 ? turnId.trim() : 'unknown_turn';
}

export function computeToolIdempotencyKey(params: {
  policy: ToolIdempotencyPolicy;
  toolName: string;
  args: Record<string, unknown>;
  context: ToolExecutionContext;
}): string {
  const scopeKey = resolveScopeKey(params.policy.scope, params.context);
  const json = stableStringify({ tool: params.toolName, args: params.args });
  return createHash('sha256').update(`${scopeKey}|${json}`).digest('hex').slice(0, 16);
}

export function findCachedToolOutputByIdempotencyKey(params: {
  history: ReadonlyArray<RuntimeEvent>;
  toolName: string;
  idempotencyKey: string;
}): { output: string } | undefined {
  for (let i = params.history.length - 1; i >= 0; i -= 1) {
    const e = params.history[i] as unknown as UnknownRecord;
    if (!e || typeof e !== 'object') continue;
    if (e['type'] !== 'tool_output') continue;
    if (e['tool_name'] !== params.toolName) continue;
    if (e['status'] !== 'success') continue;
    const meta = e['metadata'];
    if (!isRecord(meta)) continue;
    const idem = meta['idempotency'];
    if (!isRecord(idem)) continue;
    if (idem['key'] !== params.idempotencyKey) continue;
    const output = e['output'];
    if (typeof output !== 'string') continue;
    return { output };
  }
  return undefined;
}
