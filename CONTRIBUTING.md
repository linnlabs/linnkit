# Contributing to linnkit

Thank you for your interest in contributing to linnkit.

linnkit is an open-source project licensed under MIT. Contributions of all kinds are welcome — bug reports, documentation improvements, and code changes.

---

## Development setup

**Requirements**

- Node.js `>=22`
- pnpm `10.20.0`（由根 `packageManager` 固定）

**Getting started**

```bash
# Clone the repo (or your fork)
git clone https://github.com/linnlabs/linnkit.git
cd linnkit

# Install dependencies
corepack enable
pnpm install --frozen-lockfile

# Verify the setup
pnpm run test:smoke
```

---

## Running tests

| Command | What it runs |
|---------|-------------|
| `pnpm run test:smoke` | Linnkit package shell smoke test — verifies exports and sub-entrypoints resolve correctly |
| `pnpm run test:smoke:dist` | Linnkit runtime import + browser-safe events seam test against the built dist |
| `pnpm run test` | Linnkit core test suite |
| `pnpm run typecheck` | Linnkit core TypeScript type check (no emit) |
| `pnpm run build` | Build Linnkit core dist (required before `test:smoke:dist`) |
| `pnpm --filter @linnlabs/linnkit-provider-ai-sdk test` | AI SDK adapter unit and Provider conformance suite |
| `pnpm --filter @linnlabs/linnkit-provider-ai-sdk pack-smoke` | Build and verify the adapter's packed CJS/ESM runtime |

Before opening a PR, run locally:

```bash
pnpm run typecheck
pnpm run build
pnpm run test
pnpm --filter @linnlabs/linnkit-provider-ai-sdk typecheck
pnpm --filter @linnlabs/linnkit-provider-ai-sdk test
pnpm --filter @linnlabs/linnkit-provider-ai-sdk pack-smoke
```

All three must pass.

---

## Opening a pull request

**Checklist before marking PR ready for review**

- [ ] Linnkit core 的 `pnpm run typecheck`、`build`、`test` 全部通过
- [ ] Adapter 的 `typecheck`、`test`、`pack-smoke` 全部通过
- [ ] New public exports are documented in the relevant `docs/integration/` guide
- [ ] If you modified a public sub-entrypoint, check the snapshot test in `src/runtime-kernel/__tests__/__snapshots__/` and `src/testkit/__tests__/__snapshots__/` — update snapshots intentionally, not blindly

**Scope guidance**

- linnkit core is intentionally thin — it does not include built-in LLM providers, RAG, memory systems, or UI. Optional Provider integrations belong in a separate package such as `packages/provider-ai-sdk`; they cannot add Provider semantics or dependencies to the core.
- Bug fixes and protocol-level improvements are always welcome.
- Larger features or API surface changes: open an issue first to discuss design intent.

---

## Commit message convention

linnkit uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

Common types: `feat` / `fix` / `refactor` / `test` / `docs` / `chore`

Examples:

```
feat(ports): add TokenizerPort interface
fix(context-manager): correct fence lifetime pruning on multi-turn runs
docs(integration): simplify agent-registration-guide examples
```

---

## Code style

- TypeScript strict mode. No `any` casts — read the type definition before casting.
- Comments in code should explain *why*, not *what*. No redundant comments like `// increment counter`.
- New files: `.ts`. High cohesion, low coupling.
- No defensive or patch-style fixes. Trace bugs to their root cause.

---

## No CLA required

linnkit is MIT-licensed. No Contributor License Agreement is required. By submitting a pull request, you agree that your contribution will be licensed under MIT.

---

## Questions?

Open a [GitHub Discussion](https://github.com/linnlabs/linnkit/discussions) for questions about usage or design. Use [GitHub Issues](https://github.com/linnlabs/linnkit/issues) for bug reports and feature requests.
