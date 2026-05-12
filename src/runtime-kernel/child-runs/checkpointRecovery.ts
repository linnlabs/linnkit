import type { RuntimeEvent } from '../../contracts';
import type { Checkpointer } from '../graph-engine/checkpointer/base';
import type { EngineState } from '../graph-engine/types';

function hasSeedHistoryPrefix(history: ReadonlyArray<RuntimeEvent>, seedHistory: ReadonlyArray<RuntimeEvent>): boolean {
  if (seedHistory.length === 0) return true;
  if (history.length < seedHistory.length) return false;

  for (let i = 0; i < seedHistory.length; i += 1) {
    const historyEvent = history[i];
    const seedEvent = seedHistory[i];
    if (!historyEvent || !seedEvent) return false;
    if (historyEvent.id !== seedEvent.id || historyEvent.type !== seedEvent.type) {
      return false;
    }
  }
  return true;
}

function readCheckpointHistory(checkpoint: EngineState | null): RuntimeEvent[] {
  if (!checkpoint?.local) return [];
  const history = checkpoint.local.history;
  if (!Array.isArray(history)) return [];
  return history.filter((event): event is RuntimeEvent => {
    return !!event && typeof event === 'object' && typeof (event as RuntimeEvent).type === 'string';
  });
}

export async function recoverChildRunEventsFromCheckpoint(params: {
  checkpointer: Checkpointer;
  conversationId: string;
  internalConversationId: string;
  seedHistory: ReadonlyArray<RuntimeEvent>;
}): Promise<RuntimeEvent[]> {
  const checkpoint = await params.checkpointer.load(params.conversationId);
  const history = readCheckpointHistory(checkpoint);
  if (history.length === 0) {
    return [];
  }

  if (hasSeedHistoryPrefix(history, params.seedHistory)) {
    return history.slice(params.seedHistory.length);
  }

  return history.filter((event) => event.conversation_id === params.internalConversationId);
}
