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

    const result = await applyObservationGovernance({
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
    expect(result.observationTruncation).toEqual({
      originalChars: 14,
      previewChars: 12,
      originalLines: 1,
      previewLines: 1,
    });
  });

  it('截断端口显式回传字符计量时应优先使用端口计量', async () => {
    truncateObservationMock.mockResolvedValue({
      truncated: true,
      preview: 'line 1',
      blob_id: 'blob_1',
      originalChars: 100,
      previewChars: 6,
      originalLines: 10,
      previewLines: 1,
    });

    const parsed = {
      observation: 'line 1\nline 2',
      data: {},
    };

    const result = await applyObservationGovernance({
      parsed,
      toolName: 'search',
      toolContext: {},
      structuredObservation: 'line 1\nline 2',
      observationPreview: {
        truncateObservation: truncateObservationMock,
      },
    });

    expect(result.observationTruncation).toEqual({
      originalChars: 100,
      previewChars: 6,
      originalLines: 10,
      previewLines: 1,
    });
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

  it('应允许通过 contextPolicy 覆盖执行期 observation 阈值', async () => {
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
      policy: {
        maxChars: 4096,
        maxLines: 200,
      },
    });

    expect(truncateObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxChars: 4096,
        maxLines: 200,
      }),
    );
  });

  it('禁用 observation governance 时不应调用落盘预览端口', async () => {
    await applyObservationGovernance({
      parsed: { observation: 'very long text' },
      toolName: 'search',
      toolContext: {},
      structuredObservation: 'very long text',
      observationPreview: {
        truncateObservation: truncateObservationMock,
      },
      policy: {
        enabled: false,
      },
    });

    expect(truncateObservationMock).not.toHaveBeenCalled();
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
