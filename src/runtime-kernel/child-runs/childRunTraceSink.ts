import type { RuntimeEvent } from '../../contracts';
import type { SubRunTracePublisher } from '../child-run-trace/subrunTrace.types';
import { FinalAnswerCollector } from './finalAnswerCollector';

type FinalizeChildRunTraceOptions = {
  isComplete?: boolean;
};

export type ChildRunTraceSink = ((evt: unknown) => RuntimeEvent[]) & {
  finalize?: (options?: FinalizeChildRunTraceOptions) => RuntimeEvent[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

function getBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  return typeof v === 'boolean' ? v : undefined;
}

function normalizePhase(v: string | undefined): 'start' | 'update' | 'complete' | 'error' | undefined {
  if (!v) return undefined;
  if (v === 'start' || v === 'update' || v === 'complete' || v === 'error') {
    return v;
  }
  return undefined;
}

function normalizeStatus(v: string | undefined): 'loading' | 'success' | 'error' | undefined {
  if (!v) return undefined;
  if (v === 'loading' || v === 'success' || v === 'error') {
    return v;
  }
  return undefined;
}

export function createChildRunTraceSink(params: {
  publisher: SubRunTracePublisher;
  conversationId: string;
  turnId: string;
}): ChildRunTraceSink {
  const { publisher, conversationId, turnId } = params;
  const finalAnswerCollector = new FinalAnswerCollector(conversationId, turnId);

  const sink = (evt: unknown) => {
    if (!isRecord(evt)) {
      return [];
    }
    const type = getString(evt, 'type');
    if (!type) {
      return [];
    }

    const sourceEventId = getString(evt, 'id');
    const commonMeta: Record<string, unknown> = {
      source_event_type: type,
      ...(sourceEventId ? { source_event_id: sourceEventId } : {}),
    };

    switch (type) {
      case 'thought': {
        const delta = getString(evt, 'delta');
        const content = getString(evt, 'content');
        const isComplete = getBoolean(evt, 'is_complete') === true;

        if (delta) {
          publisher.publish({
            kind: 'thought_delta',
            delta,
            meta: commonMeta,
          });
        }

        if (isComplete) {
          publisher.publish({
            kind: 'thought_complete',
            content: content ?? '',
            meta: commonMeta,
          });
        }
        return [];
      }

      case 'tool_call_decision':
      case 'tool_process': {
        const finalized = finalAnswerCollector.finalize();
        const toolArgs = evt.tool_args;
        publisher.publish({
          kind: type === 'tool_call_decision' ? 'tool_call_decision' : 'tool_process',
          tool_name: getString(evt, 'tool_name'),
          tool_call_id: getString(evt, 'tool_call_id'),
          phase: normalizePhase(getString(evt, 'phase')),
          status: normalizeStatus(getString(evt, 'status')),
          args: toolArgs,
          meta: {
            ...commonMeta,
          },
        });
        return finalized;
      }

      case 'observation': {
        const toolName = getString(evt, 'tool_name');
        const toolCallId = getString(evt, 'tool_call_id');
        const output = getString(evt, 'output');
        const success = getBoolean(evt, 'success');
        const durationMs = getNumber(evt, 'duration_ms');

        publisher.publish({
          kind: 'tool_output',
          tool_name: toolName,
          tool_call_id: toolCallId,
          status: success === false ? 'error' : 'success',
          output,
          duration_ms: durationMs,
          meta: commonMeta,
        });
        return [];
      }

      case 'stream_chunk': {
        const chunk = getString(evt, 'content');
        const answerId = getString(evt, 'answer_id');
        const seq = getNumber(evt, 'seq');
        const isLast = getBoolean(evt, 'is_last');

        if (chunk) {
          finalAnswerCollector.pushChunk(chunk, answerId);
          publisher.publish({
            kind: 'final_answer_chunk',
            delta: chunk,
            meta: {
              ...commonMeta,
              ...(answerId ? { answer_id: answerId } : {}),
              ...(typeof seq === 'number' ? { seq } : {}),
              ...(typeof isLast === 'boolean' ? { is_last: isLast } : {}),
            },
          });
        }
        return [];
      }

      case 'final_answer': {
        const answer = getString(evt, 'answer');
        const answerId = getString(evt, 'answer_id');
        if (answer) {
          publisher.publish({
            kind: 'final_answer',
            content: answer,
            meta: {
              ...commonMeta,
              ...(answerId ? { answer_id: answerId } : {}),
            },
          });
        }
        return [];
      }

      default: {
        return [];
      }
    }
  };

  sink.finalize = (options?: FinalizeChildRunTraceOptions) => {
    return finalAnswerCollector.finalize({ isComplete: options?.isComplete });
  };

  return sink;
}
