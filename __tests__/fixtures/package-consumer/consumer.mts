import { runtimeKernel } from '@linnlabs/linnkit';
import { graph, childRuns, type telemetry, type tools } from '@linnlabs/linnkit/runtime-kernel';
import type { RuntimeEvent } from '@linnlabs/linnkit/contracts';
import type { CanonicalInferencePort } from '@linnlabs/linnkit/ports';
import type {} from '@linnlabs/linnkit/runtime-kernel/events';
import type {} from '@linnlabs/linnkit/context-manager';
import type {} from '@linnlabs/linnkit/testkit';
import type {} from '@linnlabs/linnkit/quickstart';

// 模拟装包后的 Host：namespace 内的 class 必须同时保留值与实例类型。
const eventStore: graph.MemoryEventStore = new graph.MemoryEventStore();
const rootEventStore: runtimeKernel.graph.MemoryEventStore = eventStore;
const events: graph.PersistedEvent[] = await rootEventStore.range('conversation-1');
const replay: RuntimeEvent[] = events.map(entry => entry.event);
void replay;

// 泛型 parent context 必须贯穿 child-run 调用，不能退化为未检查的值。
interface ParentContext extends tools.ToolExecutionContext {
  workspaceId: string;
}
type Request = childRuns.ChildRunRequest<ParentContext>;
declare const invoker: childRuns.ChildRunInvokerPort<Request>;
declare const request: Request;
const result: childRuns.ChildRunResult = await invoker.invoke(request);
const workspaceId: string = request.parentToolContext.workspaceId;
void result;
void workspaceId;

// 负向合同证明声明没有静默丢失类型约束。
// @ts-expect-error child 请求正文必须是字符串。
request.userMessage = 42;
// @ts-expect-error EventStore 接收正式事实，不接收裸字符串。
await eventStore.append('not-an-event');

export interface HostPorts {
  inference: CanonicalInferencePort;
  tools: tools.ToolRuntimePort;
  telemetry: telemetry.TelemetryPort;
  events: graph.RuntimeEventSink;
}
