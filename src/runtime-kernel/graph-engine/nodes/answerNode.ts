import { GraphNode, EngineState, NodeResult } from '../types';
import { generateMessageId } from '../../../shared/ids';
import { Logger } from '../../../shared/logger';
import { createFinalAnswerEvent, RuntimeEvent } from '../../../contracts';

const logger = new Logger('AnswerNode');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class AnswerNode implements GraphNode {
  id = 'answer';

  async run(state: EngineState): Promise<NodeResult> {
    const local = isRecord(state.local) ? state.local : {};
    const finalAnswer = typeof local.finalAnswer === 'string' ? local.finalAnswer : undefined;
    const conversationId = typeof local.conversationId === 'string' ? local.conversationId : '';
    const turnId = typeof local.turnId === 'string' ? local.turnId : `turn_${Date.now()}`;
    const answerId = typeof local.answerId === 'string' ? local.answerId : generateMessageId();

    logger.info('[AnswerNode] 开始执行最终答案节点', {
      conversationId,
      turnId,
      answerId,
      hasFinalAnswer: Boolean(finalAnswer),
    });

    if (!finalAnswer) {
      logger.warn('[AnswerNode] 没有 finalAnswer，返回空事件');
      return { kind: 'yield', events: [] };
    }

    const finalAnswerEvent = createFinalAnswerEvent(
      generateMessageId(),
      conversationId,
      turnId,
      answerId,
      finalAnswer,
      { is_complete: true }
    );

    logger.info('[AnswerNode] 生成 final_answer RuntimeEvent', {
      runtimeId: finalAnswerEvent.id,
      answerId: finalAnswerEvent.answer_id,
      contentLength: finalAnswerEvent.content?.length ?? 0,
      conversationId,
      turnId,
    });

    const events: RuntimeEvent[] = [finalAnswerEvent];

    logger.info('[AnswerNode] 返回最终答案事件', {
      eventCount: events.length,
      runtimeEventId: events[0]?.id,
    });

    return { kind: 'yield', events };
  }
}
