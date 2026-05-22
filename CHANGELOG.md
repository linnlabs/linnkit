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

## [0.7.0] - 2026-05-12

### Added

- `defineAgent` / `runAgent` / `defineConfig` quickstart helpers
- `@linnlabs/linnkit/quickstart` public sub-entrypoint
- CLI v0: `linnkit init` / `linnkit run` / `linnkit doctor`
- `README.zh-CN.md` Chinese documentation

### Compatibility

- Non-breaking. All 0.6.x public APIs remain unchanged.

---

## [0.6.0] - 2026-05-11

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

## [0.5.0] - 2026-05-10

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
