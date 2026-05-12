import type { RuntimeEvent } from '../../contracts';

export function appendUniqueEvents(target: RuntimeEvent[], events: ReadonlyArray<RuntimeEvent>): void {
  if (events.length === 0) return;

  const seenIds = new Set(target.map((event) => event.id));
  for (const event of events) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    target.push(event);
  }
}

export function extractJudgeToolOutput(
  events: ReadonlyArray<RuntimeEvent>,
  judgeToolName?: string,
): string | undefined {
  if (typeof judgeToolName !== 'string' || judgeToolName.length === 0) {
    return undefined;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const evt = events[i];
    if (evt.type !== 'tool_output') continue;
    if (evt.tool_name !== judgeToolName) continue;
    if (evt.status !== 'success') continue;
    if (typeof evt.output === 'string' && evt.output.length > 0) {
      return evt.output;
    }
  }
  return undefined;
}

export function extractFinalAnswer(events: ReadonlyArray<RuntimeEvent>): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type !== 'final_answer') continue;
    const content = typeof event.content === 'string' ? event.content : '';
    if (content.trim().length > 0) {
      return content;
    }
  }

  const chunks: Array<{ seq: number; content: string }> = [];
  for (const event of events) {
    if (event.type === 'final_answer_chunk') {
      chunks.push({ seq: event.seq, content: event.content });
    }
  }
  if (chunks.length === 0) {
    return undefined;
  }

  chunks.sort((a, b) => a.seq - b.seq);
  const stitched = chunks.map((chunk) => chunk.content).join('').trim();
  return stitched.length > 0 ? stitched : undefined;
}

function dedupeDecisionsForTranscript(events: RuntimeEvent[]): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const seenDecisionByToolCallId = new Set<string>();
  for (const event of events) {
    if (event.type === 'tool_call_decision') {
      const toolCallId = typeof event.tool_call_id === 'string' ? event.tool_call_id : '';
      if (toolCallId && seenDecisionByToolCallId.has(toolCallId)) {
        continue;
      }
      if (toolCallId) {
        seenDecisionByToolCallId.add(toolCallId);
      }
      out.push(event);
      continue;
    }
    if (event.type === 'tool_output') {
      const toolCallId = typeof event.tool_call_id === 'string' ? event.tool_call_id : '';
      if (toolCallId) {
        seenDecisionByToolCallId.delete(toolCallId);
      }
      out.push(event);
      continue;
    }
    out.push(event);
  }
  return out;
}

export function buildChildRunTranscriptMessages(params: {
  systemPrompt: string;
  userMessage: string;
  events: RuntimeEvent[];
  eventToMessageConverter: (events: RuntimeEvent[]) => unknown[];
}): unknown[] {
  const out: unknown[] = [];
  if (params.systemPrompt.trim().length > 0) {
    out.push({ role: 'system', content: params.systemPrompt });
  }
  if (params.userMessage.trim().length > 0) {
    out.push({ role: 'user', content: params.userMessage });
  }
  const normalizedEvents = dedupeDecisionsForTranscript(params.events);
  out.push(...params.eventToMessageConverter(normalizedEvents));
  return out;
}
