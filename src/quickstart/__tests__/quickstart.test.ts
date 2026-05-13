import { describe, expect, it } from 'vitest';
import type { AgentAiEngine } from '../../ports';
import { defineAgent } from '../defineAgent';
import { defineConfig } from '../defineConfig';
import { runAgent } from '../runAgent';

function createScriptedEngine(answer: string): AgentAiEngine {
  return {
    async chatCompletion() {
      return { content: answer };
    },
    async chatCompletionStream(_modelId, _messages, _options, onContent, _onError, onFinish, _onThought, onUsage) {
      onContent?.(answer);
      onUsage?.({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      onFinish?.('stop');
    },
  };
}

describe('quickstart helpers', () => {
  it('defineAgent 补齐最小 AgentSpec，并默认使用 agent profile', () => {
    const agent = defineAgent({
      id: 'hello',
      systemPrompt: 'You are helpful.',
    });

    expect(agent.spec.id).toBe('hello');
    expect(agent.spec.version).toBe('0.0.0');
    expect(agent.spec.contextPolicy.profileId).toBe('agent');
    expect(agent.tools).toEqual([]);
  });

  it('defineConfig 拒绝重复 agent id', () => {
    const agent = defineAgent({
      id: 'hello',
      systemPrompt: 'You are helpful.',
    });

    expect(() =>
      defineConfig({
        agents: [agent, agent],
        llm: createScriptedEngine('ok'),
      }),
    ).toThrow(/duplicate agent id/);
  });

  it('runAgent 用内存 runtime 跑通 hello agent', async () => {
    const agent = defineAgent({
      id: 'hello',
      systemPrompt: 'You are helpful.',
      modelId: 'scripted',
    });
    const seen: string[] = [];

    const result = await runAgent(agent, {
      input: 'hi',
      llm: createScriptedEngine('hello back'),
      onEvent: (event) => {
        seen.push(event.type);
      },
    });

    expect(result.runId).toMatch(/^run[-_]/);
    expect(result.finalAnswer).toBe('hello back');
    expect(result.cost.tokensInput).toBe(3);
    expect(result.cost.tokensOutput).toBe(2);
    expect(result.events.some((event) => event.type === 'user_input')).toBe(true);
    expect(seen).toContain('final_answer_chunk');
  });
});
