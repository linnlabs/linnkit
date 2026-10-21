/** 字段名提示只纠正很小且唯一的拼写偏差，不改参数、不推断业务上的字段替代。 */
function spellingDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function nearestField(field: string, allowedFields: readonly string[]): string | undefined {
  const threshold = field.length < 5 ? 1 : 2;
  let nearest: string | undefined;
  let bestDistance = threshold + 1;
  for (const candidate of allowedFields) {
    if (Math.abs(field.length - candidate.length) > threshold) continue;
    const distance = spellingDistance(field, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = candidate;
    } else if (distance === bestDistance) {
      nearest = undefined;
    }
  }
  return bestDistance <= threshold ? nearest : undefined;
}

export function formatUnknownToolArguments(
  fields: readonly string[],
  allowedFields: readonly string[],
): string {
  const suggestions = fields.flatMap(field => {
    const candidate = nearestField(field, allowedFields);
    return candidate ? [`${JSON.stringify(field)} → ${JSON.stringify(candidate)}`] : [];
  });
  return [
    `Additional properties not allowed: ${fields.map(field => JSON.stringify(field)).join(', ')}.`,
    `Allowed parameters: ${allowedFields.map(field => JSON.stringify(field)).join(', ') || '(none)'}.`,
    ...(suggestions.length > 0 ? [`Possible spelling corrections: ${suggestions.join('; ')}.`] : []),
    'Remove unsupported parameters before retrying; no arguments were changed or executed.',
  ].join(' ');
}
