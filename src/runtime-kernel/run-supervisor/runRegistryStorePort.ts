export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ListRunsFilter = {
  status?: RunStatus | RunStatus[];
  parentRunId?: string;
  startedAfter?: number;
  startedBefore?: number;
  limit?: number;
  cursor?: string;
};

export type RunRecord = {
  runId: string;
  conversationId: string;
  parentRunId?: string;
  status: RunStatus;
  currentNode?: string;
  startedAt: number;
  updatedAt: number;
  iterationsUsed?: number;
  iterationBudget?: { max: number; refundable: boolean };
  errorIfAny?: { errorCode: string; message: string; recoverable: boolean };
  metadata?: Record<string, unknown>;
};

export interface RunRegistryStore {
  save(record: RunRecord): Promise<void>;
  load(runId: string): Promise<RunRecord | null>;
  list(filter?: ListRunsFilter): Promise<{ runs: RunRecord[]; nextCursor?: string }>;
  delete(runId: string): Promise<void>;
}
