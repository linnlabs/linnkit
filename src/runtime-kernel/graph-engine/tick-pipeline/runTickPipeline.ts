import type { TickAroundMiddleware, TickPipelineContext, TickStage } from './types';

export async function runTickPipeline(
  ctx: TickPipelineContext,
  stages: readonly TickStage[],
  middlewares: readonly TickAroundMiddleware[] = [],
): Promise<void> {
  for (const stage of stages) {
    let runner = () => stage.run(ctx);

    for (let index = middlewares.length - 1; index >= 0; index -= 1) {
      const middleware = middlewares[index]!;
      const next = runner;
      runner = () => middleware(ctx, stage, next);
    }

    await runner();
  }
}
