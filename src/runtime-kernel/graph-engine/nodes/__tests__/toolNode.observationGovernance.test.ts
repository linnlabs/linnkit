import { beforeEach, describe, expect, it, vi } from 'vitest';

const { truncateObservationMock } = vi.hoisted(() => ({
  truncateObservationMock: vi.fn(),
}));

import { applyObservationGovernance } from '../toolNode.observationGovernance';

describe('toolNode.observationGovernance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无 structuredObservation 时应直接跳过', async () => {
    await applyObservationGovernance({
      parsed: { observation: 'hello' },
      toolName: 'search',
      toolContext: {},
      structuredObservation: undefined,
      observationPreview: {
        truncateObservation: truncateObservationMock,
      },
    });

    expect(truncateObservationMock).not.toHaveBeenCalled();
  });

  it('截断后应回写 preview 和 tool_output_store 指针', async () => {
    truncateObservationMock.mockResolvedValue({
      truncated: true,
      preview: 'preview text',
      blob_id: 'blob_1',
    });

    const parsed = {
      observation: 'very long text',
      data: {},
    };

    await applyObservationGovernance({
      parsed,
      toolName: 'search',
      toolContext: {},
      structuredObservation: 'very long text',
      observationPreview: {
        truncateObservation: truncateObservationMock,
      },
    });

    expect(parsed.observation).toBe('preview text');
    expect(parsed.data).toEqual({ tool_output_store: { blob_id: 'blob_1' } });
  });

  it('应使用执行期 observation 预览阈值', async () => {
    truncateObservationMock.mockResolvedValue({
      truncated: false,
      preview: 'unchanged',
    });

    await applyObservationGovernance({
      parsed: { observation: 'content' },
      toolName: 'search',
      toolContext: {},
      structuredObservation: 'content',
      observationPreview: {
        truncateObservation: truncateObservationMock,
      },
    });

    expect(truncateObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxChars: 20_000,
        maxLines: 1_200,
      }),
    );
  });

  it('应按工具名组装 uiMeta', async () => {
    truncateObservationMock.mockResolvedValue({
      truncated: false,
      preview: 'unchanged',
    });

    await applyObservationGovernance({
      parsed: {
        observation: 'doc content',
        data: {
          uri: 'shared_memory://docs/design',
          doc_name: 'design.md',
        },
      },
      toolName: 'resource_read',
      toolContext: {},
      structuredObservation: 'doc content',
      observationPreview: {
        truncateObservation: truncateObservationMock,
      },
    });

    expect(truncateObservationMock).toHaveBeenCalledTimes(1);
    expect(truncateObservationMock.mock.calls[0]?.[0]?.meta).toEqual({
      doc_name: 'design.md',
    });
  });
});
