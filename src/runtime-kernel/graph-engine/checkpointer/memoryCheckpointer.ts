import { ENGINE_STATE_SCHEMA_VERSION, type EngineState } from '../types';
import {
  summarizeCheckpoint,
  type Checkpointer,
  type CheckpointListFilter,
  type CheckpointMeta,
  type CheckpointSummary,
} from './base';

export class MemoryCheckpointer implements Checkpointer {
  private store = new Map<string, { state: EngineState; savedAt: number }>();

  private cloneState(state: EngineState): EngineState {
    return {
      ...state,
      schemaVersion: state.schemaVersion ?? ENGINE_STATE_SCHEMA_VERSION,
      local:
        state.local && typeof state.local === 'object' && !Array.isArray(state.local)
          ? { ...state.local }
          : state.local,
    };
  }

  async load(conversationId: string): Promise<EngineState | null> {
    const entry = this.store.get(conversationId);
    return entry ? this.cloneState(entry.state) : null;
  }

  async save(conversationId: string, state: EngineState): Promise<void> {
    this.store.set(conversationId, {
      state: this.cloneState(state),
      savedAt: Date.now(),
    });
  }

  async clear(conversationId: string): Promise<void> {
    this.store.delete(conversationId);
  }

  async peekMeta(conversationId: string): Promise<CheckpointMeta | null> {
    const entry = this.store.get(conversationId);
    return entry ? summarizeCheckpoint(conversationId, entry.state, entry.savedAt) : null;
  }

  async list(filter: CheckpointListFilter = {}): Promise<CheckpointSummary[]> {
    const summaries = Array.from(this.store.entries())
      .map(([conversationId, entry]) => summarizeCheckpoint(conversationId, entry.state, entry.savedAt))
      .filter((summary) => (filter.savedAfter === undefined ? true : summary.savedAt > filter.savedAfter))
      .sort((left, right) => right.savedAt - left.savedAt);

    if (filter.limit === undefined) {
      return summaries;
    }

    return summaries.slice(0, filter.limit);
  }
}
