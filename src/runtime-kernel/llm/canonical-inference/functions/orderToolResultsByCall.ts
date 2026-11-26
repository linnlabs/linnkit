import type { CanonicalInferenceMessage } from '../../../../ports';

/**
 * 把紧跟在 assistant 工具调用后的那一段工具结果，按调用在 assistant 里的顺序排列。
 *
 * 并行执行时结果按完成先后写入历史，顺序会随耗时变化。有的 Provider 按位置把结果
 * 对应到调用，顺序不稳定也会让前缀缓存失效。只在这一段结果都能对应到该 assistant 的
 * 调用时才重排，排序稳定；其余情况原样保留，交给上游的配对校验处理。
 */
export function orderToolResultsByCall(
  messages: readonly CanonicalInferenceMessage[],
): CanonicalInferenceMessage[] {
  const ordered = [...messages];
  for (let index = 0; index < ordered.length; index += 1) {
    const assistant = ordered[index];
    if (assistant.role !== 'assistant') continue;
    const callOrder = new Map<string, number>();
    for (const part of assistant.parts) {
      if (part.type === 'tool_call' && !callOrder.has(part.call.id)) {
        callOrder.set(part.call.id, callOrder.size);
      }
    }
    if (callOrder.size < 2) continue;
    let end = index + 1;
    while (end < ordered.length && ordered[end].role === 'tool') end += 1;
    const results = ordered.slice(index + 1, end);
    const ranks = results.map(message => (message.role === 'tool' ? callOrder.get(message.tool_call_id) : undefined));
    if (results.length < 2 || ranks.some(rank => rank === undefined)) continue;
    const sorted = results
      .map((message, position) => ({ message, position, rank: ranks[position] ?? 0 }))
      .sort((left, right) => left.rank - right.rank || left.position - right.position)
      .map(item => item.message);
    ordered.splice(index + 1, sorted.length, ...sorted);
    index = end - 1;
  }
  return ordered;
}
