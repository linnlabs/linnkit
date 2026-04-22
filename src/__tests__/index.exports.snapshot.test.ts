import { describe, expect, it } from 'vitest';

describe('src/agent public exports snapshot', () => {
  it('exposes the documented root public surface', async () => {
    const moduleUnderTest = await import('../index');
    expect(Object.keys(moduleUnderTest).sort()).toMatchSnapshot();
  });

  it('keeps compat exports isolated and internal helpers private', async () => {
    const moduleUnderTest = await import('../index');
    const symbols = Object.keys(moduleUnderTest);

    expect(symbols).not.toContain('TokenCalculator');
    expect(symbols).not.toContain('errorClassifier');
    expect(symbols).not.toContain('logger');
    expect(symbols).not.toContain('contextManager');
    expect(symbols).not.toContain('llmTelemetryContext');
    expect(symbols).not.toContain('llmAuditRecorder');

    expect(symbols).toContain('contracts');
    expect(moduleUnderTest.linnkitCompat).toBeDefined();
    expect(Object.keys(moduleUnderTest.linnkitCompat).sort()).toMatchInlineSnapshot(`
      [
        "contextManager",
        "llmAuditRecorder",
        "llmTelemetryContext",
      ]
    `);
  });
});
