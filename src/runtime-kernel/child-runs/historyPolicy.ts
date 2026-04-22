import type { ChildRunHistoryPolicy } from './types';
import type { RuntimeEvent } from '../../contracts';

export function defaultChildRunHistoryEventFilter(event: RuntimeEvent): boolean {
  return event.type === 'user_input' || event.type === 'final_answer';
}

export function pickChildRunSeedHistory(params: {
  parentHistory: ReadonlyArray<RuntimeEvent>;
  historyPolicy?: ChildRunHistoryPolicy;
}): RuntimeEvent[] {
  const { parentHistory, historyPolicy } = params;
  const inheritTurns = historyPolicy?.inheritTurns ?? 0;
  if (inheritTurns <= 0) {
    return [];
  }

  const eventFilter = historyPolicy?.eventFilter ?? defaultChildRunHistoryEventFilter;
  const selectedReversed: RuntimeEvent[] = [];
  let userCount = 0;

  for (let i = parentHistory.length - 1; i >= 0; i -= 1) {
    const event = parentHistory[i];
    if (!eventFilter(event)) {
      continue;
    }
    selectedReversed.push(event);
    if (event.type === 'user_input') {
      userCount += 1;
      if (userCount >= inheritTurns) {
        break;
      }
    }
  }

  return selectedReversed.reverse();
}
