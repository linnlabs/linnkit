import type { RuntimeEvent } from './events';

/**
 * Context Manager 向执行宿主报告摘要生命周期的唯一回调合同。
 *
 * 这里刻意只传递框架事实，不暴露 Host 的 SSE 表示：Host 负责为短生命周期的
 * presentation 创建 identity，并把 `summaryEvent` 作为独立 durable fact 发布。
 * Graph Engine、Context Manager 与 Host 必须共同导入本合同，禁止复制宽 `unknown` 形状。
 */
export interface SummarizationCallbacks {
  onSummarizationStart?: () => void;
  onSummarizationEnd?: (info: {
    originalMessageCount: number;
    summaryTokenCount?: number;
    newSummaryId?: string;
    /** 完成回调必须携带刚创建的 durable history_summary 事实。 */
    summaryEvent: Extract<RuntimeEvent, { type: 'history_summary' }>;
  }) => void;
  onSummarizationError?: (error: Error) => void;
}
