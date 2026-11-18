/**
 * 运行中途由 Host 交给 Graph 的用户输入（插话）。
 *
 * `id` 直接成为送达后 `user_input` 事实的事件身份：同一条插话因提交失败被重新取用时，
 * 事件身份不变，Host 可以据此去重。
 */
export interface PendingUserInput {
  readonly id: string;
  readonly content: string;
  readonly timestamp?: number;
}

/**
 * 运行中插话的 Host 端口（可选运行能力，不进入 checkpoint）。
 *
 * Graph 只在一批工具全部结算、即将回到模型时取用：
 * - `claim` 取走当前待送达的输入；在 `confirm` 前这些条目仍归 Host 所有，不得被撤回后又送达。
 * - 边界提交成功后调用 `confirm`；提交失败调用 `release`，条目回到待送达。
 *
 * 没有装配该端口的 Host 行为不变。子运行不接收插话。
 */
export interface PendingUserInputPort {
  claim(): Promise<readonly PendingUserInput[]> | readonly PendingUserInput[];
  confirm(ids: readonly string[]): Promise<void> | void;
  release(ids: readonly string[]): Promise<void> | void;
}
