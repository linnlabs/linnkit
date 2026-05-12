import { describe, expect, it } from 'vitest';
import {
  ContextCheckpointTool,
  createContextCheckpointTool,
} from '../contextCheckpointTool';
import { CHECKPOINT_MARKER_TYPE } from '../../../shared/checkpointMarker';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseToolResult(output: string): Record<string, unknown> {
  const parsed = JSON.parse(output) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('tool result should be an object');
  }
  return parsed;
}

function readData(output: string): Record<string, unknown> {
  const result = parseToolResult(output);
  const data = result.data;
  if (!isRecord(data)) {
    throw new Error('tool result data should be an object');
  }
  return data;
}

describe('ContextCheckpointTool', () => {
  it('默认输出 linnkit 可识别的 checkpoint marker 与 summary', async () => {
    const tool = new ContextCheckpointTool();

    const output = await tool.run({ summary: '阶段一完成，下一步验证。' }, {});
    const data = readData(output);
    const result = parseToolResult(output);

    expect(tool.name).toBe('context_checkpoint');
    expect(data._type).toBe(CHECKPOINT_MARKER_TYPE);
    expect(data.summary).toBe('阶段一完成，下一步验证。');
    expect(result.observation).toContain('阶段一完成');
  });

  it('summary 缺失或空字符串时拒绝执行', async () => {
    const tool = new ContextCheckpointTool();

    await expect(tool.run({}, {})).rejects.toThrow('summary');
    await expect(tool.run({ summary: '   ' }, {})).rejects.toThrow('summary');
  });

  it('summary 超过上限时拒绝执行', async () => {
    const tool = new ContextCheckpointTool({ summaryMaxLength: 4 });

    await expect(tool.run({ summary: '12345' }, {})).rejects.toThrow('max length is 4');
  });

  it('host hook 可以扩展 payload 与 observation，但不能覆盖 marker 和 summary', async () => {
    const tool = createContextCheckpointTool({
      buildPayloadExtension: ({ context }) => ({
        _type: 'bad_marker',
        summary: 'bad summary',
        conversation_id: context.conversationId,
        taskstate: { phase: 'verify' },
      }),
      buildObservation: ({ payload }) => `custom observation: ${String(payload.conversation_id)}`,
    });

    const output = await tool.run(
      { summary: '真实 summary' },
      { conversationId: 'conv_1' },
    );
    const data = readData(output);
    const result = parseToolResult(output);

    expect(data._type).toBe(CHECKPOINT_MARKER_TYPE);
    expect(data.summary).toBe('真实 summary');
    expect(data.conversation_id).toBe('conv_1');
    expect(result.observation).toBe('custom observation: conv_1');
  });

  it('支持自定义工具名与额外参数 schema', () => {
    const tool = new ContextCheckpointTool({
      name: 'phase_checkpoint',
      extraParameters: {
        taskstate: {
          type: 'object',
          description: 'Host task state snapshot',
        },
      },
      requiredExtraParameters: ['taskstate'],
    });

    expect(tool.name).toBe('phase_checkpoint');
    expect(tool.parameters.required).toEqual(['summary', 'taskstate']);
    expect(tool.parameters.properties.taskstate?.type).toBe('object');
  });
});
