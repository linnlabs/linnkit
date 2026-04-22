import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as appSchemas from '@app/schemas';
import * as agentContracts from '../index';

const movedRuntimeExports = [
  'AiMessage',
  'RuntimeEvent',
  'createFinalAnswerEvent',
  'createErrorEvent',
  'validateRuntimeEvent',
] as const;

describe('contracts migration boundary', () => {
  it('keeps moved A-class runtime exports on src/agent/contracts', () => {
    for (const exportName of movedRuntimeExports) {
      expect(agentContracts).toHaveProperty(exportName);
    }
  });

  it('does not continue exposing moved A-class runtime exports from @app/schemas root', () => {
    for (const exportName of movedRuntimeExports) {
      expect(appSchemas).not.toHaveProperty(exportName);
    }
  });

  it('removes legacy A-class subpath exports from @app/schemas package metadata', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../../packages/schemas/package.json', import.meta.url), 'utf8'),
    ) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports).toBeDefined();
    expect(packageJson.exports).not.toHaveProperty('./runtime-events');
    expect(packageJson.exports).not.toHaveProperty('./domain-models');
  });

  it('removes legacy A-class source files and their derived dead surfaces from packages/schemas', () => {
    expect(
      readFileSync(new URL('../../../../packages/schemas/src/index.ts', import.meta.url), 'utf8'),
    ).not.toContain("./view-models");
    expect(
      readFileSync(new URL('../../../../packages/schemas/src/index.ts', import.meta.url), 'utf8'),
    ).not.toContain("./runtime-models");

    expect(
      existsSync(new URL('../../../../packages/schemas/src/domain-models.ts', import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL('../../../../packages/schemas/src/runtime-events.ts', import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL('../../../../packages/schemas/src/view-models.ts', import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL('../../../../packages/schemas/src/runtime-models.ts', import.meta.url)),
    ).toBe(false);
  });
});
