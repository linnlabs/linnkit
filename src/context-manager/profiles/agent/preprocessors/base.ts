export type MissingSidecarBehavior = 'allow' | 'degrade_to_text' | 'provider_empty_replay_field';

export interface ToolReplayProtocolPolicy {
  provider?: string;
  requiresReasoningDetailsForToolReplay?: boolean;
  missingSidecarBehavior?: MissingSidecarBehavior;
}

declare module '../../../shared/preprocessors/base' {
  interface PreprocessorContext {
    /**
     * Agent profile 专属的 provider replay 治理策略。
     *
     * 中文说明：基类实现仍归 shared；agent 只通过类型增广补自己的上下文字段，
     * 避免为了一个 profile 字段复制整套 BasePreprocessor。
     */
    toolReplayProtocolPolicy?: ToolReplayProtocolPolicy;
  }
}

export {
  BasePreprocessor,
} from '../../../shared/preprocessors/base';

export type {
  IPreprocessor,
  PreprocessorContext,
  PreprocessorResult,
  ToolSummaryProvider,
} from '../../../shared/preprocessors/base';
