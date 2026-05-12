import { describe, expect, it } from 'vitest';
import type { AgentInvocationRequest } from '../../../ports';
import type { RuntimeEvent } from '../../../contracts';
import { applySystemReminders } from '../apply';
import { SystemReminderRegistry } from '../registry';

const request: AgentInvocationRequest = {
  query: 'hello',
  promptKey: 'default',
  mode: 'agent',
  availableTools: ['context_checkpoint', 'phase_checkpoint'],
};

function baseEvent(type: RuntimeEvent['type'], id: string): Pick<RuntimeEvent, 'id' | 'conversation_id' | 'timestamp' | 'turn_id' | 'version'> & { type: RuntimeEvent['type'] } {
  return {
    id,
    type,
    conversation_id: 'conv-1',
    turn_id: 'turn-1',
    timestamp: Date.now(),
    version: 1,
  };
}

function userInput(id: string): RuntimeEvent {
  return {
    ...baseEvent('user_input', id),
    type: 'user_input',
    content: 'question',
    source: 'user',
  };
}

function toolDecision(id: string): RuntimeEvent {
  return {
    ...baseEvent('tool_call_decision', id),
    type: 'tool_call_decision',
    tool_name: 'search',
    tool_call_id: id,
    phase: 'complete',
    status: 'success',
  };
}

describe('applySystemReminders', () => {
  it('按 systemReminder.enabledRuleIds 只启用指定规则', () => {
    const injected: string[][] = [];
    const result = applySystemReminders({
      llmMessages: [{ role: 'user', content: '请继续' }],
      ctx: {
        request,
        history: [],
        executorLocal: {
          stepCount: 10,
          maxSteps: 10,
          remainingSteps: 0,
          phase: 'force_final_answer',
          systemReminderPolicy: {
            enabledRuleIds: ['last_steps_hint'],
            thresholds: { lastStepsHintThreshold: 2 },
          },
        },
      },
      onInjected: ({ ruleIds }) => injected.push(ruleIds),
    });

    expect(JSON.stringify(result)).not.toContain('最大步数限制');
    expect(JSON.stringify(result)).not.toContain('<system-reminder>');
    expect(injected).toEqual([]);
  });

  it('按 systemReminder.thresholds 覆盖工具调用连续提醒阈值', () => {
    const result = applySystemReminders({
      llmMessages: [{ role: 'user', content: '继续' }],
      ctx: {
        request,
        history: [userInput('u1'), toolDecision('t1'), toolDecision('t2')],
        executorLocal: {
          stepCount: 2,
          maxSteps: 20,
          remainingSteps: 18,
          systemReminderPolicy: {
            enabledRuleIds: ['tool_call_streak_every_ten'],
            thresholds: { toolCallStreak: 2 },
          },
        },
      },
    });

    expect(JSON.stringify(result)).toContain('你已连续执行了 2 次工具调用');
  });

  it('支持通过注册表解释 host extraRules', () => {
    const registry = new SystemReminderRegistry();
    registry.registerTriggerKind('always', () => true);
    registry.registerContentTemplate('customTemplate', (_ctx, args) => `自定义提醒：${String(args?.name ?? '')}`);

    const result = applySystemReminders({
      llmMessages: [{ role: 'user', content: '继续' }],
      registry,
      ctx: {
        request,
        history: [],
        executorLocal: {
          stepCount: 1,
          systemReminderPolicy: {
            enabledRuleIds: [],
            extraRules: [
              {
                id: 'custom_rule',
                trigger: { kind: 'always' },
                contentTemplate: 'customTemplate',
                contentArgs: { name: 'memory' },
              },
            ],
          },
        },
      },
    });

    expect(JSON.stringify(result)).toContain('自定义提醒：memory');
  });

  it('上下文预算提醒使用 executorLocal.contextCheckpointToolName', () => {
    const result = applySystemReminders({
      llmMessages: [{ role: 'user', content: '继续' }],
      ctx: {
        request,
        history: [],
        executorLocal: {
          stepCount: 18,
          maxSteps: 20,
          remainingSteps: 2,
          contextCheckpointToolName: 'phase_checkpoint',
          systemReminderPolicy: {
            enabledRuleIds: ['context_budget_warning'],
            thresholds: { budgetWarningRatio: 0.9 },
          },
        },
      },
    });

    expect(JSON.stringify(result)).toContain('调用 phase_checkpoint 工具');
  });
});
