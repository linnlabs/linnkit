# linnkit

**A fine-grained context engineering framework for Agent applications — control every token sent to the model, with clear run lifecycle, audit records, and testable protocol boundaries.**

[中文文档](./README.zh-CN.md) · [Integration Guide](./docs/integration/README.md) · [Changelog](./CHANGELOG.md)

---

## What is linnkit?

linnkit is a foundational skeleton for Agent applications:

| Layer | Responsibility |
|-------|---------------|
| `runtime-kernel` | Run agents, run tools, manage run lifecycle, record events, handle cancellation and cost |
| `context-manager` | Build the context sent to the model, trim to budget, inject host context |
| `ports` | Interfaces the host must implement: LLM, tools, storage, tokenizer |
| `testkit` | Guard the protocol with tests, not oral agreements |

linnkit has no built-in LLM provider, no database binding, no UI, and no opinions on RAG, memory, permissions, or IM integrations. Those belong to your product.

---

## Why use linnkit?

**Fine-grained context control** — Describe your entire context strategy declaratively with `AgentSpec.contextPolicy`. Configure token budget, tool history retention, summarization triggers, must-keep rules, checkpoint compression, reasoning retention, system reminder injection, observation truncation with full-copy archiving, provider sidecar replay, and custom tokenizer. The context sent to the model is not a hand-assembled `messages[]` array — it's a rule-driven, recorded build process.

**ContextTrace observability** — Every context build produces a machine-readable trace: which messages were kept, which were trimmed, why, how many tokens each step consumed, and whether the final result exceeded the budget. When the model answers incorrectly, you don't need to guess whether context was lost — you can read the trace directly.

**Managed run lifecycle** — `RunSupervisor` and `RunHandle` turn each agent invocation into a stateful run with its own `runId`, cancellation, observable event stream, state queries, cost accounting, synchronous child runs, and spawnable detached background runs. Agents behave like real services, not temporary function calls.

**Audit-first design** — `AuditEnvelope` and `AuditPort` capture important decisions — model selection, tool rejection, fallback, awaiting user input, sandbox decisions — into a unified audit stream. Not for appearances, but so you can answer: *why did the system do that?*

**Clean host boundaries via fence injection** — linnkit doesn't know what "document chunk", "knowledge base", or "project memory" means in your product. Hosts register their own context types as fence families. linnkit handles the rules: when to keep them, when to trim them, how to observe them — without hardcoding business vocabulary.

**Protocol invariants, not conventions** — linnkit's testkit enforces 26 strict invariants: final tokens must not exceed budget, tool calls and outputs must not be separated, must-keep messages must never be trimmed, run state must not stay `running` after termination, budget decisions must actually use the injected custom tokenizer... The more complex an Agent system becomes, the more these invariants protect you from small changes silently breaking the protocol.

---

## What problems does it solve?

If you've built Agent products before, you've likely run into these:

- Context is hard to manage — it's difficult to observe exactly what gets sent to the LLM each time.
- Long conversations make it unclear what the model actually sees.
- As tool calls accumulate, deciding what to keep vs. compress becomes guesswork.
- After a user cancels, run state, event stream, tool execution, and frontend UI can fall out of sync.
- When multiple agents call each other, cost, events, and errors across parent/child runs are hard to trace.
- A bug can't be reproduced because nobody recorded how context was trimmed at the time.
- Tests only check "did the final answer look right" but can't catch a broken protocol.

linnkit's goal is to turn these into configurable, observable, and testable engineering problems.

---

## What linnkit does NOT do

These capabilities matter, but they are not linnkit's responsibility:

- No built-in OpenAI / Claude / Gemini provider.
- No built-in RAG, vector store, knowledge base, or memory system.
- No built-in tools (search, file read/write, browser, IM).
- No built-in UI, console, or DevTools platform.
- No opinions on permissions, security policy, or billing strategy.

linnkit provides boundaries and protocols to make these easier to integrate. The implementations belong to your product.

This is what allows linnkit to serve multiple different host applications rather than becoming an internal framework for one specific product.

---

## Quick start

Install:

```bash
npm install @linnlabs/linnkit
```

Create a demo host:

```bash
npx linnkit init demo-agent
cd demo-agent
npm install
```

After configuring environment variables, check your setup:

```bash
npx linnkit doctor
```

Run a hello agent:

```bash
npx linnkit run hello --input "Describe linnkit in one sentence"
```

This quickstart is for getting up and running quickly — it's not a production setup. Production hosts should assemble their own LLM, tools, storage, audit, and context policy by following the [integration guide](./docs/integration/README.md).

---

## Minimal code example

```ts
import { defineAgent, runAgent } from '@linnlabs/linnkit/quickstart';

const agent = defineAgent({
  id: 'hello',
  version: '0.1.0',
  role: 'Assistant',
  systemPrompt: 'You are a concise, reliable assistant.',
  modelId: 'gpt-4o-mini',
  capabilities: ['agent'],
  tools: [],
  contextPolicy: {
    budget: { maxTokens: 16_000, reservedForResponse: 2_000 },
  },
});

const result = await runAgent(agent, { input: 'What is linnkit?', llm });
console.log(result.finalAnswer);
```

---

## Public sub-entrypoints

| Sub-entrypoint | Purpose |
|---------------|---------|
| `@linnlabs/linnkit` | Root entry — exports main namespaces |
| `@linnlabs/linnkit/ports` | Interfaces the host must implement |
| `@linnlabs/linnkit/contracts` | Stable data structures: `AgentSpec`, `AiMessage`, `RuntimeEvent` |
| `@linnlabs/linnkit/runtime-kernel` | Graph engine, tool runtime, run supervisor |
| `@linnlabs/linnkit/runtime-kernel/events` | Browser-safe event governance pure functions |
| `@linnlabs/linnkit/context-manager` | Context build, fence registry, message formatter, context policy |
| `@linnlabs/linnkit/testkit` | Test harnesses and 26 protocol invariants |
| `@linnlabs/linnkit/quickstart` | Demo / development helpers |

> **Browser rule**: do not import `@linnlabs/linnkit/runtime-kernel` in a frontend bundle — it pulls in Node-only sub-trees. For frontend event display logic only, use `@linnlabs/linnkit/runtime-kernel/events`.

---

## Documentation

| Document | Content |
|----------|---------|
| [docs/integration/README.md](./docs/integration/README.md) | Integration hub — start here |
| [docs/integration/01-installation.md](./docs/integration/01-installation.md) | Install and registry auth |
| [docs/integration/02-quickstart.md](./docs/integration/02-quickstart.md) | Quickstart demo |
| [docs/integration/agent-registration-guide.md](./docs/integration/agent-registration-guide.md) | Agent registration and `AgentSpec` |
| [docs/integration/context-engineering.md](./docs/integration/context-engineering.md) | Context policy, ContextTrace, TokenizerPort |
| [docs/integration/context-fences.md](./docs/integration/context-fences.md) | Host context injection |
| [docs/integration/tools.md](./docs/integration/tools.md) | Tool integration overview |
| [docs/integration/tool-development-guide.md](./docs/integration/tool-development-guide.md) | Tool design internals |
| [docs/integration/run-supervisor.md](./docs/integration/run-supervisor.md) | Run lifecycle management |
| [docs/integration/testing.md](./docs/integration/testing.md) | Testkit and invariants |
| [CHANGELOG.md](./CHANGELOG.md) | Public release history |

---

## Status

- **Version**: see [`package.json`](./package.json)
- **Distribution**: npmjs.com public registry
- **Stability**: `0.x` — public sub-entrypoints are locked; Context Engineering API stable since 0.6.0
- **Open source**: MIT package; source repo split is required before the formal OSS announcement

## License

MIT — see [LICENSE](./LICENSE).
