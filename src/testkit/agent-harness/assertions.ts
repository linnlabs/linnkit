import { expect } from 'vitest';
import type { ScriptedLlmCall } from './scriptedAiEngineHarness';
import type { RuntimeEvent } from '../../contracts';

function messageContentOf(messages: unknown[]): string[] {
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return '';
      const record = message as Record<string, unknown>;
      return typeof record.content === 'string' ? record.content : '';
    })
    .filter((content) => content.length > 0);
}

function isFinalAnswerEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { type: 'final_answer' }> {
  return event.type === 'final_answer';
}

export function expectMessagesContainToolResult(call: ScriptedLlmCall, expectedText: string): void {
  const hasMatch = call.messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const record = message as Record<string, unknown>;
    return record.role === 'tool' && typeof record.content === 'string' && record.content.includes(expectedText);
  });
  expect(hasMatch).toBe(true);
}

export function expectToolOutputFedBackToHistory(call: ScriptedLlmCall, expectedText: string): void {
  expectMessagesContainToolResult(call, expectedText);
}

export function expectFinalStepForcedTools(call: ScriptedLlmCall, forcedToolName: string): void {
  const toolChoice = call.options.tool_choice;
  expect(toolChoice).toEqual({
    type: 'function',
    function: { name: forcedToolName },
  });

  const tools = Array.isArray(call.options.tools) ? call.options.tools : [];
  expect(tools).toHaveLength(1);
  const tool = tools[0];
  if (!tool || typeof tool !== 'object') {
    throw new Error('[expectFinalStepForcedTools] llm options.tools[0] 不是对象。');
  }
  const fn = (tool as { function?: unknown }).function;
  if (!fn || typeof fn !== 'object') {
    throw new Error('[expectFinalStepForcedTools] llm options.tools[0].function 缺失。');
  }
  expect((fn as { name?: unknown }).name).toBe(forcedToolName);
}

export function expectRunEndedWithFinalAnswer(events: RuntimeEvent[], expectedText: string): void {
  const finalAnswerEvent = [...events]
    .reverse()
    .find(isFinalAnswerEvent);
  expect(finalAnswerEvent).toBeDefined();
  if (!finalAnswerEvent) {
    throw new Error('[expectRunEndedWithFinalAnswer] final_answer event missing.');
  }
  expect(finalAnswerEvent.content).toContain(expectedText);
}

export function expectMessagesContainText(call: ScriptedLlmCall, expectedText: string): void {
  const contents = messageContentOf(call.messages);
  expect(contents.some((content) => content.includes(expectedText))).toBe(true);
}
