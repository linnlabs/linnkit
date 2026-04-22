import type { RuntimeEvent } from '../../contracts';
import { createFinalAnswerEvent } from '../../contracts';

export class FinalAnswerCollector {
  private answerId: string | undefined;
  private readonly chunks: string[] = [];
  private chunkCount = 0;

  constructor(
    private readonly conversationId: string,
    private readonly turnId: string
  ) {}

  pushChunk(chunk: string, answerId?: string): void {
    if (!chunk) return;
    if (answerId && answerId.length > 0) {
      this.answerId = answerId;
    }
    this.chunkCount += 1;
    this.chunks.push(chunk);
  }

  finalize(options?: { isComplete?: boolean; timestamp?: number }): RuntimeEvent[] {
    const content = this.chunks.join('').trim();
    if (!content) {
      this.reset();
      return [];
    }

    const answerId = this.answerId;
    if (!answerId) {
      this.reset();
      return [];
    }

    const timestamp = typeof options?.timestamp === 'number' ? options.timestamp : Date.now();
    const isComplete = options?.isComplete !== false;

    const runtime = createFinalAnswerEvent(
      answerId,
      this.conversationId,
      this.turnId,
      answerId,
      content,
      {
        timestamp,
        is_complete: isComplete,
        meta: { chunk_count: this.chunkCount },
      }
    );

    this.reset();
    return [runtime];
  }

  reset(): void {
    this.answerId = undefined;
    this.chunks.length = 0;
    this.chunkCount = 0;
  }
}
