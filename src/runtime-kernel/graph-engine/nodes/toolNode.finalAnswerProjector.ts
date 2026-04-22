function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 中文备注：
 * - 这里集中收口“工具输出如何投影为最终答案”的显式规则；
 * - ToolNode 只负责执行工具与路由，业务级映射规则放到单独模块，避免节点继续膨胀。
 */
export function resolveFinalAnswerFromToolResult(toolName: string, parsedResult: unknown): string | undefined {
  if (!isRecord(parsedResult)) {
    return undefined;
  }

  const data = parsedResult.data;
  if (!isRecord(data)) {
    if (toolName === 'write_report') {
      throw new Error('[write_report] 工具输出缺少 data（必须包含 data.report）');
    }
    if (toolName === 'research_run_writer') {
      throw new Error('[research_run_writer] 工具输出缺少 data（必须包含 data.success 与 data.final_answer）');
    }
    return undefined;
  }

  if (toolName === 'write_report') {
    const report = readNonEmptyString(data.report);
    if (!report) {
      throw new Error('[write_report] 工具输出缺少 data.report（必须提供完整报告正文）');
    }
    return report;
  }

  if (toolName === 'research_run_writer') {
    if (data.success !== true) {
      return undefined;
    }
    const finalAnswer = readNonEmptyString(data.final_answer);
    if (!finalAnswer) {
      throw new Error('[research_run_writer] 工具输出缺少 data.final_answer（success=true 时必须提供最终报告正文）');
    }
    return finalAnswer;
  }

  return undefined;
}

