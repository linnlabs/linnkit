# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: linnkit is in `0.x` — minor versions may introduce new public exports
> but patch versions should remain compatible.
>
> Versions before 0.5.0 were internal alpha and are summarized only at a high level here.

---

## [Unreleased]

## [0.21.0] - 2026-06-20

> Published release. This is the first npm / GitHub Release after `0.10.0`; it includes the unpublished `0.11.0`-`0.20.0` internal milestones below.

### Added

- `GraphExecutorContextBuildOutput` can now carry context token components and context component ledger entries.
- `context_build` telemetry events now accept `tokenComponents` and `tokenLedgerEntry`.
- The build context stage creates a `context-component` ledger entry from kept context components and emits it with context build telemetry.

### Compatibility

- Minor bump because runtime-kernel context builder and telemetry contracts expose new optional context component accounting fields.

## [0.20.0] - 2026-06-20 (unpublished milestone; included in 0.21.0)

### Added

- Context trace now records build-time `ContextTokenComponent[]` for final message states when token breakdown tracing is enabled.
- Added context token component derivation for system, user, assistant, tool, fence, context injection, and history summary messages.
- Tool components with execution-time observation truncation metadata now expose build-time `originalTokensEstimate` and `droppedTokensEstimate`.

### Compatibility

- Minor bump because `@linnlabs/linnkit/context-manager` context traces expose new token component breakdown data.

## [0.19.0] - 2026-06-20 (unpublished milestone; included in 0.21.0)

### Added

- `ContextTokenComponent` can now carry execution-time tool observation truncation estimates: `truncatedAtExecution`, `originalTokensEstimate`, and `droppedTokensEstimate`.

### Compatibility

- Minor bump because `@linnlabs/linnkit/contracts` exposes new optional context component accounting fields.

## [0.18.0] - 2026-06-20 (unpublished milestone; included in 0.21.0)

### Added

- Added `ObservationTruncationMeta` in `@linnlabs/linnkit/contracts` for execution-time tool observation truncation character metrics.
- `ObservationPreviewResult` can now return optional `originalChars`, `previewChars`, `originalLines`, and `previewLines` when a host truncates and stores a tool observation.
- `ToolNode` writes execution-time observation truncation metrics to `tool_output.metadata.observationTruncation`; token estimation remains deferred to context build.

### Compatibility

- Minor bump because `@linnlabs/linnkit/contracts` and runtime-kernel tool ports expose new optional observation truncation metadata.

## [0.17.0] - 2026-06-19 (unpublished milestone; included in 0.21.0)

### Added

- Added `ContextBuildTokenEstimate` from `@linnlabs/linnkit/contracts` to expose build-time local and calibrated context token estimates.
- `GraphExecutorContextBuildOutput` can now carry `tokenEstimate`, and runtime-kernel emits a `context_build` telemetry event when it is present.
- Exported pure `addUsageTotals` and `addLedgerAggregate` helpers from `@linnlabs/linnkit/runtime-kernel` for host-side collectors.

### Changed

- `contextPolicy.tokenEstimation.calibration` now supports `minCoefficient`; the default lower bound is `1` to avoid under-budgeting from noisy samples.

### Compatibility

- Minor bump because `@linnlabs/linnkit/contracts`, `@linnlabs/linnkit/runtime-kernel`, and telemetry event types expose new public APIs.

## [0.16.0] - 2026-06-18 (unpublished milestone; included in 0.21.0)

### Added

- Added the optional `TokenCounterPort` from `@linnlabs/linnkit/ports` for route-aware preflight token counts.
- `contextPolicy.tokenEstimation.remoteCount` can now opt into remote preflight counting during context build.
- `AgentMessageOrchestrator` accepts a host-supplied `tokenCounter` and `resolveTokenRoute` hook without changing default behavior.
- `ContextTrace` records whether remote count was enabled, attempted, applied, and which route was used.

### Changed

- Remote count is only attempted when the policy is enabled, a counter is injected, and the current `TokenRoute` explicitly declares `supportsRemoteTokenCount`.
- `mergeContextPolicy` now merges nested token estimation calibration and remote count policies field-by-field.

### Compatibility

- Minor bump because `@linnlabs/linnkit/ports` and `@linnlabs/linnkit/context-manager` expose new public token counting APIs.

## [0.15.0] - 2026-06-18 (unpublished milestone; included in 0.21.0)

### Added

- Added opt-in token usage calibration contracts from `@linnlabs/linnkit/contracts` for route-scoped actual-usage samples and auditable calibration traces.
- `AgentMessageOrchestrator` can now receive route-scoped calibration samples for context budgeting, while default behavior remains unchanged.
- `ContextTrace` now records token calibration status, coefficient, sample count, and sample ledger entry IDs when trace is enabled.

### Changed

- Context token estimates only apply calibration when `contextPolicy.tokenEstimation.calibration.enabled` is true and enough same-route actual samples are available.

### Compatibility

- Minor bump because `@linnlabs/linnkit/contracts` and `@linnlabs/linnkit/context-manager` expose new public token calibration APIs.

## [0.14.0] - 2026-06-18 (unpublished milestone; included in 0.21.0)

### Changed

- `RunCost` now uses `tokenUsage` as the canonical run-level token aggregate and no longer exposes the ambiguous single-call `canonicalUsage` field.
- Legacy `RunCost.tokensInput` and `RunCost.tokensOutput` remain for compatibility and should be read as projections from the run-level token aggregate.

### Compatibility

- Minor bump because `@linnlabs/linnkit/runtime-kernel` changes the public `RunCost` shape by removing the ambiguous `canonicalUsage` field.

## [0.13.0] - 2026-06-18 (unpublished milestone; included in 0.21.0)

### Added

- Added `TokenPricing`, `CostBreakdown`, and `TokenCostComponent` contracts for host-supplied effective per-million token prices.
- Added pure `computeCost(usage, pricing)` from `@linnlabs/linnkit/runtime-kernel` for input/output/reasoning/cache cost breakdowns.

### Changed

- `computeCost` reports `status: 'unknown'` when a required price is missing instead of treating missing prices as zero.

### Compatibility

- Minor bump because `@linnlabs/linnkit/contracts` and `@linnlabs/linnkit/runtime-kernel` expose new public cost accounting APIs.

## [0.12.0] - 2026-06-18 (unpublished milestone; included in 0.21.0)

### Added

- Added token ledger contracts from `@linnlabs/linnkit/contracts`: `TokenLedgerEntry`, `LlmUsageTokenLedgerEntry`, `ContextComponentTokenLedgerEntry`, `ContextTokenComponent`, `TokenUsageTotals`, `TokenLedgerAggregate`, and `RunTokenUsageAggregate`.
- Added `tokenAccounting` helpers from `@linnlabs/linnkit/runtime-kernel` for pure canonical usage aggregation, ledger entry creation, and parent/child run token aggregation without double counting.
- `llm_call` telemetry and `RunCost` can now carry optional token ledger references/aggregates while preserving the existing prompt/completion fields.

### Changed

- `ContextTrace` now has optional token ledger sidecars for component breakdowns without depending on runtime-kernel internals.

### Compatibility

- Minor bump because `@linnlabs/linnkit/contracts` and `@linnlabs/linnkit/runtime-kernel` expose new public token accounting APIs.

## [0.11.0] - 2026-06-18 (unpublished milestone; included in 0.21.0)

### Added

- Added token usage contracts from `@linnlabs/linnkit/contracts`: `CanonicalLlmUsage`, `TokenRoute`, `TokenRouteCapabilities`, `TokenCountSource`, and `TokenCountConfidence`.
- `llm_call` telemetry now carries canonical usage alongside the legacy prompt/completion token shape when provider usage can be normalized.
- `AgentAiEngine` responses can now return `canonicalUsage`, and `@linnlabs/linnkit/ports` exposes the optional `UsageNormalizer` type for hosts that centralize usage mapping.

### Changed

- Local LLM telemetry estimates now use the injected `TokenizerPort` instead of calling `TokenCalculator` directly.
- Legacy `NormalizedLlmUsage` no longer fabricates prompt/completion tokens from a total-only `usage.tokens` payload; unknown input/output stays unknown and falls back to local estimates.
- OpenAI-compatible default usage normalization now splits cached input tokens out of `prompt_tokens` and preserves `completion_tokens_details.reasoning_tokens` when reported.

### Compatibility

- Minor bump because `@linnlabs/linnkit/contracts` exposes new public runtime schemas and the `AgentAiEngine` port accepts canonical usage metadata.

## [0.10.0] - 2026-06-15

### Changed

- `GraphExecutor` / `Checkpointer` now name engine-state snapshot keys as `checkpointKey`, and graph telemetry reads the runtime `conversationId` from graph local state instead of treating the checkpoint key as a host conversation.
- Synchronous child runs can now receive an explicit host `conversationId` while still using an internal checkpoint key for GraphExecutor state isolation. This keeps RuntimeEvent / Audit / Telemetry scope aligned with the child run registered by the host and prevents EventStore-backed audit writes from mixing a child `runId` with an internal conversation key.
- Detached runs now execute against the `AgentSpec`, request, and metadata snapshots captured during `spawnDetached()` registration, so later caller-side object mutations cannot change the background run context.

### Compatibility

- Minor bump because `Checkpointer` / `CheckpointMeta` host adapter contracts now use `checkpointKey` for graph persistence identity. Host adapters that previously treated the graph checkpoint key as a user conversation id should pass host `conversationId` explicitly and reserve `checkpointKey` for engine snapshots.

---

## [0.9.0] - 2026-05-22

### Added

- `appendStreamingProviderReasoningDetails` / `compactProviderReasoningDetails` / `compactReasoningDetailsInValue` in `@linnlabs/linnkit/runtime-kernel` — provider-agnostic helpers for merging adjacent streaming `reasoning_content` fragments.

### Fixed

- Streaming `reasoning_details` now merges adjacent pure text reasoning fragments before returning the final LLM result and before emitting provider sidecar updates, preventing audit records from storing token-by-token reasoning fragments.
- `ToolNode` now drains every pending `assistant.tool_calls` item in the current batch before returning to the LLM, even when an earlier tool call fails. This preserves the protocol invariant that each tool call receives a corresponding tool output and avoids incomplete tool-call groups being dropped by downstream context assembly.
- Tool protocol fuse handling now waits until the current batch has been fully consumed before throwing, so one repeated protocol error cannot strand later tool calls in the same assistant message.

### Compatibility

- Minor bump because `@linnlabs/linnkit/runtime-kernel` has new public exports and ToolNode batch execution behavior is stricter.

---

## [0.8.0] - 2026-05-13

### Added

- `TokenizerPort` interface in `@linnlabs/linnkit/ports` — host-injectable token estimation contract
- `DefaultTokenizerPort` + `createDefaultTokenizerPort(config)` in `@linnlabs/linnkit/runtime-kernel` — wraps the existing `TokenCalculator` (tiktoken + char-ratio fallback) behind the new interface
- `ContextManagerBaseOptions.tokenizer` / `tokenizerModelId` on `AgentContextManager`, `ChatContextManager`, `AgentMessageOrchestrator`, `ChatMessageOrchestrator` — inject once at assembly time, drives all budget decisions
- `updateTokenizerModelId(modelId)` on `ContextManagerBase` — required when reusing one context manager across multiple models
- `createMockTokenizerPort()` in `@linnlabs/linnkit/testkit` — fixed-token-per-message mock for deterministic budget / trimming tests
- `C12_HOST_TOKENIZER_DRIVES_BUDGET` strict invariant in testkit `context-harness` — proves injected tokenizer actually drives `message-decision.tokens` and `trace.finalTokens`

### Compatibility

- Non-breaking. Hosts not injecting `tokenizer` continue using `TokenCalculator` with 0.7.x behavior unchanged.
- `contextPolicy.tokenEstimation` (encoding / avgCharsPerToken / toolCallOverhead) continues to configure the default tokenizer when no custom tokenizer is injected.

---

## [0.7.0] - 2026-05-12 (pre-npmjs milestone; superseded by 0.8.0)

### Added

- `defineAgent` / `runAgent` / `defineConfig` quickstart helpers
- `@linnlabs/linnkit/quickstart` public sub-entrypoint
- CLI v0: `linnkit init` / `linnkit run` / `linnkit doctor`
- `README.zh-CN.md` Chinese documentation

### Compatibility

- Non-breaking. All 0.6.x public APIs remain unchanged.

---

## [0.6.0] - 2026-05-11 (pre-npmjs milestone; superseded by 0.8.0)

### Added

- 12-group `AgentSpec.contextPolicy`: `budget` / `toolHistory` / `toolOutput` / `providerReplay` / `summarization` / `mustKeep` / `workingMemory` / `checkpoint` / `reasoningRetention` / `tokenEstimation` / `systemReminder` / `contextTrace`
- `defineContextPolicy()` helper — merges defaults and validates group combination constraints
- `ContextTrace` machine-readable sidecar of every context build decision
- `SystemReminder` registry + trigger/template extension points
- `ContextCheckpointTool` / `createContextCheckpointTool()` — host-neutral active checkpoint tool
- 11 additional strict invariants in testkit `context-harness` (total: 26 — 15 run + 11 contextPolicy + C12 tokenizer added in 0.8.0)
- `docs/integration/` restructured: 18 topic-specific guides each with Front Matter

### Compatibility

- Non-breaking. Hosts using the pre-0.6.0 flat `contextPolicy` shape are auto-migrated via `defineContextPolicy()`.

---

## [0.5.0] - 2026-05-10 (pre-npmjs milestone; superseded by 0.8.0)

### Added

- `AgentSpec` — first-class serializable agent blueprint (id / version / capabilities / tools / contextPolicy / modelHints / audit / metadata)
- `RunSupervisor` + `RunHandle` v2: `cancel` / `observe` / `cost` / `spawnDetached` / `waitForTerminal` / `drain` / `recoverOnBoot`
- `invokeChildRun` — synchronous child run with cost roll-up to parent
- `AuditEnvelope` + `AuditPort` — structured logging for non-deterministic decisions
- Tool history compression: `per-pair` / `per-run` / `none` strategies + `overflowStrategy`
- testkit with 15 strict run invariants
- Documentation reorganized: 17 topic-specific guides under `docs/integration/`

### Compatibility

- First stable public API surface. Sub-entrypoints locked.
