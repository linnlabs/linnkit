import { describe, expect, it } from 'vitest';
import {
  computeCitationOffset,
  isRecord,
  parseJsonSafe,
  readString,
} from '../toolNode.helpers';

describe('toolNode.helpers', () => {
  it('computeCitationOffset 只统计当前 turn 的 tool_output.citations', () => {
    const offset = computeCitationOffset(
      [
        {
          type: 'tool_output',
          turn_id: 'turn_a',
          payload: {
            result: {
              data: {
                citations: {
                  citations: [{ id: 1 }, { id: 2 }],
                },
              },
            },
          },
        },
        {
          type: 'tool_output',
          turn_id: 'turn_b',
          payload: {
            result: {
              data: {
                citations: {
                  citations: [{ id: 3 }],
                },
              },
            },
          },
        },
        {
          type: 'thought',
          turn_id: 'turn_a',
        },
      ] as never,
      'turn_a',
    );

    expect(offset).toBe(2);
  });

  it('parseJsonSafe 应对合法与非法 JSON 保持稳定', () => {
    expect(parseJsonSafe('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonSafe('not-json')).toBeNull();
    expect(parseJsonSafe(undefined)).toBeNull();
  });

  it('isRecord / readString 提供最小收窄能力', () => {
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(readString('  hello  ')).toBe('hello');
    expect(readString('   ')).toBeUndefined();
  });
});
