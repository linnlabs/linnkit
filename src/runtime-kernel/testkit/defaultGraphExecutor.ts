import { GraphExecutor } from '../graph-engine/engine';
import { MemoryCheckpointer } from '../graph-engine/checkpointer/memoryCheckpointer';
import type { Checkpointer } from '../graph-engine/checkpointer/base';
import { AnswerNode } from '../graph-engine/nodes/answerNode';
import { ToolNode } from '../graph-engine/nodes/toolNode';
import { UserNode } from '../graph-engine/nodes/userNode';
import { WaitUserNode } from '../graph-engine/nodes/waitUserNode';
import type { GraphNode } from '../graph-engine/types';
import type { ObservationPreviewPort, ToolRuntimePort } from '../tools';

export interface DefaultGraphExecutorOptions {
  llmNode: GraphNode;
  toolRuntime: ToolRuntimePort;
  observationPreview: ObservationPreviewPort;
  maxSteps?: number;
  checkpointer?: Checkpointer;
}

export function createDefaultGraphExecutor(
  options: DefaultGraphExecutorOptions,
): GraphExecutor {
  const executor = new GraphExecutor(
    options.checkpointer ?? new MemoryCheckpointer(),
    { maxSteps: options.maxSteps ?? 8 },
  );
  executor.registerNode(new UserNode());
  executor.registerNode(options.llmNode);
  executor.registerNode(new ToolNode({
    toolRuntime: options.toolRuntime,
    observationPreview: options.observationPreview,
  }));
  executor.registerNode(new AnswerNode());
  executor.registerNode(new WaitUserNode());
  return executor;
}
