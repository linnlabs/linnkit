import { describe, expect, it } from 'vitest';

import {
  createGraphScenario,
  formatModelMessages,
  validateSteeringInvariants,
  type ScriptedLlmTurn,
} from '../../index';

const search: ScriptedLlmTurn = { toolCalls: [{ name: 'search', arguments: { q: 'x' } }] };
const answer = (text: string): ScriptedLlmTurn => ({ contentChunks: [text] });

describe('createGraphScenario', () => {
  it('工具执行中插话：整批结算后送达，下一次模型调用排在工具结果之后看到', async () => {
    const scenario = createGraphScenario({
      model: [search, answer('done')],
      tools: { search: () => { scenario.steer('只看今年的'); return 'found 3'; } },
    });

    const run = await scenario.start('查一下 X');

    expect(run).toMatchObject({ status: 'yielded', undeliveredSteers: [] });
    expect(await scenario.timeline()).toEqual([
      'user "查一下 X"',
      'call search#call_1_1',
      'result search#call_1_1 success "found 3"',
      'steer "只看今年的"',
      'answer "done"',
    ]);
    expect(formatModelMessages(scenario.modelCalls()[1]).slice(-2)).toEqual([
      'tool #call_1_1 "found 3"',
      'user "只看今年的"',
    ]);
    await scenario.assertInvariants();
  });

  it('最后一次模型调用中插话：本次运行不再送达，运行结束时收回', async () => {
    const scenario = createGraphScenario({
      model: [search, { ...answer('done'), assertCall: () => { scenario.steer('再补一句'); } }],
      tools: { search: () => 'found' },
    });

    const run = await scenario.start('查一下 X');

    expect(run.status).toBe('yielded');
    expect(run.undeliveredSteers.map(input => input.content)).toEqual(['再补一句']);
    expect((await scenario.timeline()).some(line => line.startsWith('steer'))).toBe(false);
  });

  it('同一批里两条插话按提交顺序送达；下一轮对话仍各看到一次', async () => {
    const scenario = createGraphScenario({
      model: [
        { toolCalls: [{ name: 'search' }, { name: 'search' }] },
        answer('first done'),
        answer('second done'),
      ],
      tools: {
        search: ({ count }) => { scenario.steer(`补充${count}`); return `hit ${count}`; },
      },
    });

    await scenario.start('第一轮');
    await scenario.start('第二轮');

    const timeline = await scenario.timeline();
    expect(timeline.filter(line => line.startsWith('steer'))).toEqual(['steer "补充1"', 'steer "补充2"']);
    expect(formatModelMessages(scenario.modelCalls()[2]).filter(line => line.includes('补充'))).toHaveLength(2);
    await scenario.assertInvariants();
  });

  it('暂停后插话收回，继续后完成剩下的工具与回答', async () => {
    const scenario = createGraphScenario({
      model: [{ toolCalls: [{ name: 'write' }, { name: 'write' }] }, answer('complete')],
      tools: {
        write: ({ count }) => {
          if (count === 1) {
            scenario.steer('暂停前写的');
            scenario.pause();
          }
          return `saved ${count}`;
        },
      },
    });

    const paused = await scenario.start('写两页');
    expect(paused.status).toBe('paused');
    expect(paused.undeliveredSteers.map(input => input.content)).toEqual(['暂停前写的']);

    const resumed = await scenario.continue();
    expect(resumed.status).toBe('yielded');
    expect(scenario.tools.executions.map(item => item.outcome)).toEqual(['success', 'success']);
    expect((await scenario.timeline()).at(-1)).toBe('answer "complete"');
    await scenario.assertInvariants();
  });

  it('按请求决定回合：看到工具结果后再回答', async () => {
    const scenario = createGraphScenario({
      model: call => (call.messages.some(message => message.role === 'tool') ? answer('saw result') : search),
      tools: { search: () => 'r' },
    });

    await scenario.start('go');

    expect(scenario.modelCalls()).toHaveLength(2);
    expect((await scenario.timeline()).at(-1)).toBe('answer "saw result"');
  });

  it('工具报错、端口抛错与存储失败都以运行状态返回，不打断测试', async () => {
    const reported = createGraphScenario({
      model: [search, answer('recovered')],
      tools: { search: () => ({ error: 'not found', errorCode: 'search.empty' }) },
    });
    expect((await reported.start('go')).status).toBe('yielded');
    expect((await reported.timeline())[2]).toMatch(/^result search#call_1_1 error/);

    const crashed = createGraphScenario({
      model: [search],
      tools: { search: () => { throw new Error('boom'); } },
    });
    const crashedRun = await crashed.start('go');
    expect(crashedRun.status).toBe('failed');
    expect(String(crashedRun.error)).toContain('boom');

    const diskFull = createGraphScenario({
      model: [search, answer('never')],
      tools: { search: () => 'r' },
      beforeCheckpointWrite: ({ events }) => {
        if (events.some(event => event.type === 'tool_output')) throw new Error('disk full');
      },
    });
    const failedRun = await diskFull.start('go');
    expect(failedRun.status).toBe('failed');
    expect(String(failedRun.error)).toContain('disk full');
  });
});

describe('validateSteeringInvariants', () => {
  it('模型没收到插话时报告 S3，插话重复出现时报告 S4', async () => {
    const scenario = createGraphScenario({
      model: [search, answer('done')],
      tools: { search: () => { scenario.steer('换个方向'); return 'r'; } },
    });
    await scenario.start('go');
    const history = await scenario.history();
    const [first, second] = scenario.modelCalls();
    const dropSteer = { ...second, messages: second.messages.filter(message => message.role !== 'user' || !JSON.stringify(message).includes('换个方向')) };
    const doubleSteer = { ...second, messages: [...second.messages, second.messages.at(-1)!] };

    expect(validateSteeringInvariants({ history, modelCalls: [first, dropSteer] }).map(f => f.id))
      .toEqual(['S3_STEER_IN_NEXT_MODEL_CALL']);
    expect(validateSteeringInvariants({ history, modelCalls: [first, doubleSteer] }).map(f => f.id))
      .toEqual(['S4_STEER_ONCE_PER_MODEL_CALL']);
  });
});
