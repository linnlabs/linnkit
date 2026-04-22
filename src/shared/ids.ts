import { randomUUID } from 'crypto';

function shortRandomId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function generateMessageId(): string {
  return shortRandomId('msg');
}

export function generateConversationId(): string {
  return shortRandomId('conv');
}

export function generateRunId(): string {
  return shortRandomId('run');
}

export function generateExecutionId(): string {
  return shortRandomId('exec');
}

export function generateTraceId(): string {
  return shortRandomId('trace');
}
