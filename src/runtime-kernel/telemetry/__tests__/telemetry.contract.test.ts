import { describe, expect, it } from 'vitest';

import { noopTelemetry } from '../noopTelemetry';
import { TELEMETRY_EVENT_KINDS } from '../telemetryEvents';
import type { TelemetryEvent } from '../telemetryPort';

describe('TelemetryPort contract', () => {
  it('declares the four stable telemetry event kinds', () => {
    expect(TELEMETRY_EVENT_KINDS).toEqual([
      'llm_call',
      'tool_call',
      'graph_node',
      'run_lifecycle',
    ]);
  });

  it('provides a noop telemetry sink that safely accepts events', async () => {
    const event: TelemetryEvent = {
      kind: 'llm_call',
      modelId: 'gpt-4.1',
      stream: true,
      durationMs: 120,
      scope: {
        conversationId: 'conv-1',
        runId: 'run-1',
      },
    };

    expect(() => noopTelemetry.emit(event)).not.toThrow();
    await expect(noopTelemetry.flush?.()).resolves.toBeUndefined();
  });
});
