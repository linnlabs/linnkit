import type { NormalizedLlmUsage } from '../../shared/llmTelemetryContext';
import type {
  CanonicalLlmUsage,
  ContextBuildTokenEstimate,
  ContextComponentTokenLedgerEntry,
  ContextTokenComponent,
  LlmUsageTokenLedgerEntry,
} from '../../contracts';
import type { TelemetryEventKind } from './telemetryEvents';

export type TelemetryScope = {
  conversationId?: string;
  runId?: string;
  parentRunId?: string;
  turnId?: string;
  stepId?: string;
};

export type TelemetryEvent =
  | {
      kind: Extract<TelemetryEventKind, 'llm_call'>;
      modelId: string;
      stream: boolean;
      durationMs: number;
      usage?: NormalizedLlmUsage;
      canonicalUsage?: CanonicalLlmUsage;
      tokenLedgerEntry?: LlmUsageTokenLedgerEntry;
      scope: TelemetryScope;
    }
  | {
      kind: Extract<TelemetryEventKind, 'tool_call'>;
      toolName: string;
      durationMs: number;
      ok: boolean;
      errorCode?: string;
      scope: TelemetryScope;
    }
  | {
      kind: Extract<TelemetryEventKind, 'context_build'>;
      modelId: string;
      mode: 'agent' | 'chat';
      tokenEstimate: ContextBuildTokenEstimate;
      tokenComponents?: ContextTokenComponent[];
      tokenLedgerEntry?: ContextComponentTokenLedgerEntry;
      scope: TelemetryScope;
    }
  | {
      kind: Extract<TelemetryEventKind, 'graph_node'>;
      nodeId: string;
      durationMs: number;
      scope: TelemetryScope;
    }
  | {
      kind: Extract<TelemetryEventKind, 'run_lifecycle'>;
      runId: string;
      phase: 'spawned' | 'completed' | 'failed' | 'cancelled';
      scope: TelemetryScope;
    };

export interface TelemetryPort {
  emit(event: TelemetryEvent): void;
  flush?(): Promise<void>;
}
