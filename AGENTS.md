# AGENTS.md

## 0. Agent scope & identity

You are an AI coding agent working inside this repository only.

Your primary goals:

- Implement features and fixes as requested.
- Preserve existing architecture and public contracts.
- Maintain reliability, security, and performance.

You must:

- Prefer small, reviewable changes.
- Explain non-trivial decisions in comments or commit messages (if available).
- Ask for clarification when a change would break explicit constraints below.

## 1. Project overview

**Purpose of this repo:**

`@stdiobus/mcp-agentic` is a multi-agent orchestration server that connects MCP (Model Context Protocol) clients to ACP-compatible agents through stdio Bus. It is a TypeScript library and CLI published to npm.

**Core domains / bounded contexts:**

- **MCP tool layer** — 8 MCP tools for health, agent discovery, session management, cancellation, and one-shot delegation (`src/mcp/`).
- **Executor layer** — two execution backends: `InProcessExecutor` (in-memory agents via `AgentHandler`) and `WorkerExecutor` (external ACP processes via `@stdiobus/node` StdioBus) (`src/executor/`).
- **Server orchestration** — `McpAgenticServer` is the single public entry point; it owns the MCP server, tool registration, executor resolution, backpressure, and input validation (`src/server/`).
- **Provider layer** — `AIProvider` interface, `ProviderRegistry`, and three built-in providers (OpenAI, Anthropic, Google Gemini) using their native SDKs (`src/provider/`).
- **Multi-provider agent** — `MultiProviderCompanionAgent` implements `AgentHandler` and delegates to any registered provider with dynamic runtime parameter control (`src/agent/MultiProviderCompanionAgent.ts`).
- **Error handling** — `BridgeError` with typed categories (`CONFIG`, `AUTH`, `TRANSPORT`, `UPSTREAM`, `TIMEOUT`, `PROTOCOL`, `INTERNAL`) and MCP error code mapping (`src/errors/`).
- **Observability** — structured logging to stderr with correlation ID support (`src/observability/`).

**Critical invariants:**

- In-process agents always take priority over workers when an agent ID exists in both.
- stdout is reserved exclusively for the MCP wire protocol. All logging goes to stderr.
- `McpAgenticServer` is the only public entry point. All tool logic is delegated to handler functions in `src/mcp/tools/`.
- Input validation (prompt size, metadata size) and backpressure (concurrent request limiting) must be enforced before any executor call.
- Sessions are isolated per executor. Session IDs must never leak across executor boundaries.
- The CLI binary (`npx @stdiobus/mcp-agentic`) starts with zero agents and cannot delegate work. Production use requires a custom entry point with `server.register()` calls.
- Provider SDKs (`openai`, `@anthropic-ai/sdk`, `@google/generative-ai`) are peer/optional dependencies — users install only the SDKs they need.
- Providers do not access `process.env` after construction. All credentials are passed via the `ProviderConfig.credentials` record at instantiation time.

## 2. Environment & assumptions

**Runtime:**

- Node.js: >= 20.0.0
- TypeScript: ^5.8.3 with strict mode enabled (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`)
- ES2022 target, NodeNext module resolution
- ESM-only (`"type": "module"` in package.json)

**Package manager:**

npm. Use `npm install`, `npm run`, etc. The repo includes both `package-lock.json` and `yarn.lock`; prefer npm for consistency with the scripts in `package.json`.

**Local services:**

None. No databases, queues, or external services are required for development or testing. The `@stdiobus/node` dependency is mocked in unit tests via `test/__mocks__/@stdiobus/node.ts`.

Do not assume internet access unless explicitly granted.

## 3. Setup & commands

Always use these commands when working with the project:

- **Install dependencies:** `npm install`
- **Build (full):** `npm run build` (clean + esbuild bundle + tsc declarations)
- **Build JS only:** `npm run build:js` (esbuild bundle)
- **Build types only:** `npm run build:types` (tsc declaration files to `out/tsc/`)
- **Type check:** `npm run typecheck` (tsc --noEmit, no output)
- **Run unit tests:** `npm run test:unit` (Jest with `NODE_OPTIONS=--experimental-vm-modules`)
- **Run e2e tests:** `npm run test:e2e` (bash `test/e2e/run-all.sh`)
- **Run all tests:** `npm run test:all` (unit + e2e)
- **Run tests with coverage:** `npm run test:coverage`
- **Run live provider e2e tests:** `npm run test:e2e:providers` (requires API keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`; tests skip gracefully when keys are absent)
- **Clean:** `npm run clean` (removes `out/`, `dist/`, `coverage/`)

Rule: Before you propose final changes, run `npm run typecheck` and `npm run test:unit`. If you changed e2e-relevant code, also run `npm run test:e2e`.

## 4. Repository & architecture map

**High-level structure:**

```
src/                     — All production source code
  server/                — McpAgenticServer (single public entry point)
  agent/                 — AgentHandler interface + MultiProviderCompanionAgent
    AgentHandler.ts      — AgentHandler interface (user-implemented agents)
    MultiProviderCompanionAgent.ts — Multi-provider agent implementing AgentHandler
  executor/              — Execution backends (InProcessExecutor, WorkerExecutor, AgentExecutor interface)
  provider/              — AI provider abstraction layer
    AIProvider.ts        — AIProvider interface, RuntimeParams, ChatMessage, ProviderConfig types
    ProviderRegistry.ts  — Provider registration, discovery, and retrieval
    providers/           — Built-in provider implementations
      OpenAIProvider.ts  — OpenAI via 'openai' SDK
      AnthropicProvider.ts — Anthropic via '@anthropic-ai/sdk'
      GoogleGeminiProvider.ts — Google Gemini via '@google/generative-ai'
    index.ts             — Re-exports for provider layer
  mcp/                   — MCP tool definitions and handler functions
    tools/               — Individual tool handlers (agents, health, sessions, tasks)
    tool-definitions.ts  — Centralized tool metadata with JSON Schema from Zod
  errors/                — BridgeError class and MCP error code mapping
  observability/         — Logger and correlation ID utilities
  cli/                   — CLI reference server entry point
  types.ts               — Zod schemas for MCP tool inputs and logging config
  index.ts               — Public API re-exports
build/                   — esbuild configuration
test/
  unit/                  — Unit tests mirroring src/ structure
    provider/            — Provider layer unit tests (ProviderRegistry, RuntimeParams)
      providers/         — Individual provider unit tests (OpenAI, Anthropic, Gemini)
    agent/               — MultiProviderCompanionAgent unit tests
  e2e/                   — End-to-end tests (self-contained TypeScript scripts run via tsx)
    providers/           — Live provider e2e tests (require API keys, skip when absent)
  __mocks__/             — Manual mocks (@stdiobus/node, openai, @anthropic-ai/sdk, @google/generative-ai)
    @stdiobus/node.ts    — StdioBus mock
    openai.ts            — OpenAI SDK mock
    @anthropic-ai/sdk.ts — Anthropic SDK mock
    @google/generative-ai.ts — Google Gemini SDK mock
steering/                — Steering guides for AI agent usage of this power
scripts/                 — Development helper scripts (test clients, server runners)
examples/                — Example usage (sandbox-multi-agent.ts)
```

**Key entrypoints:**

- **Library:** `src/index.ts` → `out/dist/index.js` (ESM bundle via esbuild)
- **CLI binary:** `src/cli/server.ts` → `out/dist/cli/server.js` (with shebang, via esbuild)
- **Type declarations:** `out/tsc/index.d.ts` (via tsc with `tsconfig.types.json`)

## 5. Coding conventions

**Language:**

TypeScript strict mode: true. Do not weaken typings. All strict flags are enabled including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

**Style:**

- Quotes: single quotes.
- Semicolons: yes.
- All imports use `.js` extensions (required for NodeNext module resolution).
- Import order: Node.js builtins first, then external packages, then internal modules. Type-only imports use `import type`.
- Section separators use `// ── Section Name ───────────` comment style.
- JSDoc comments on public APIs and module-level doc blocks.
- Prefer pure functions where possible; side effects in handlers and executors.

**Error handling:**

Use `BridgeError` with typed categories (`CONFIG`, `AUTH`, `TRANSPORT`, `UPSTREAM`, `TIMEOUT`, `PROTOCOL`, `INTERNAL`) for all domain errors. Each category has a static factory method (e.g., `BridgeError.config(...)`, `BridgeError.upstream(...)`). Do not throw raw strings. Errors are mapped to MCP JSON-RPC error codes via `mapErrorToMCP()` in `src/errors/error-mapper.ts`.

**Logging:**

Use the `Logger` class from `src/observability/logger.ts`. All log output goes to stderr only — stdout is reserved for the MCP wire protocol. Do not log secrets, tokens, or PII. Include correlation IDs in log context where available.

## 6. Testing strategy

When you change code:

Always add or update tests covering:
- Happy path.
- Relevant edge cases.
- Regressions you are fixing.

**Test locations:**

- Unit: `test/unit/` — mirrors the `src/` directory structure.
- e2e: `test/e2e/` — self-contained TypeScript scripts run via `tsx`.

**Commands:**

- Unit tests: `npm run test:unit`
- e2e tests: `npm run test:e2e`
- All tests: `npm run test:all`
- Coverage: `npm run test:coverage`

**Patterns:**

- Tests use `jest.fn<any>()` for mock typing.
- A shared `createMockExecutor()` factory in `test/unit/mcp/tools/_mockExecutor.ts` provides a pre-configured mock `AgentExecutor` for tool handler tests.
- `@stdiobus/node` is mocked via `test/__mocks__/@stdiobus/node.ts` for unit tests.
- Provider SDKs are mocked via manual mocks in `test/__mocks__/`: `openai.ts` (OpenAI SDK), `@anthropic-ai/sdk.ts` (Anthropic SDK), `@google/generative-ai.ts` (Google Gemini SDK). These mocks simulate SDK classes, response shapes, and error types for fast, offline property-based and unit testing.
- Property-based tests use `fast-check` and live alongside unit tests.
- Coverage thresholds: 85% lines, 80% branches, 85% functions, 85% statements.
- Mocks auto-clear/reset/restore between tests (`clearMocks`, `resetMocks`, `restoreMocks` all true in Jest config).
- **Live provider e2e tests** (`test/e2e/providers/`) make real API calls to OpenAI, Anthropic, and Google Gemini. They require API keys in environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`) and skip gracefully when keys are absent. Run via `npm run test:e2e:providers`. These tests are not part of the default CI pipeline.

If tests fail, fix them or revert the change. Do not silence or delete failing tests without reason.

## 7. Workflow rules

**Branching:**

Use branches like `feature/...`, `fix/...`.

**Commits:**

Keep commits small and focused.

Examples:
- `feat: add capability filtering to agents_discover`
- `fix: prevent session leak on prompt timeout`
- `chore: update esbuild to 0.25.x`

**Pull requests:**

Title format: `[scope] short description`

PR must include:
- Summary of changes.
- Risks and mitigations.
- How to test (commands + steps).

## 8. Safety, secrets & destructive operations

Never hardcode secrets, tokens, or passwords.

Do not read or modify:
- `.env*` files, secret stores, or credentials in CI configs.
- Worker environment variables containing API keys (passed via `WorkerConfig.env` at runtime).

Destructive operations (data loss, dropping tables, truncating logs, deleting resources) are forbidden unless:
- The user explicitly asks for such operations and confirms understanding of the risk.

Do not add code that:
- Sends production data to external services not already configured.
- Weakens authentication or authorization checks.
- Writes anything to stdout that is not MCP wire protocol data.

If you are unsure whether a change might be destructive, ask before proceeding.

## 9. Tooling & integrations

**Internal CLI:**

`npx @stdiobus/mcp-agentic` — starts the reference server with zero agents. Useful for verifying MCP connectivity (`bridge_health`) and inspecting tool schemas. Cannot delegate work.

**MCP tools (8 total):**

| Tool | Purpose | Multi-provider notes |
|------|---------|---------------------|
| `bridge_health` | Check bridge readiness | — |
| `agents_discover` | List available agents, optionally filter by capability | Response includes `providers` field (array of `{ id, models }`) when agent supports multiple providers |
| `sessions_create` | Create a new agent session | `metadata.provider` selects the AI provider; `metadata.runtimeParams` sets session-level defaults |
| `sessions_prompt` | Send a prompt to an existing session | Accepts optional `runtimeParams` for per-prompt parameter overrides (model, temperature, systemPrompt, etc.) |
| `sessions_status` | Check session status | — |
| `sessions_close` | Close a session | — |
| `sessions_cancel` | Cancel an in-flight prompt | — |
| `tasks_delegate` | One-shot delegation (create + prompt + close) | Accepts optional `runtimeParams` for parameter overrides |

**Build tooling:**

- `esbuild` — bundles library and CLI binary. Config in `build/esbuild.config.mjs`.
- `tsc` — generates `.d.ts` declarations only (via `tsconfig.types.json`). Not used for JS output.

**Dev scripts:**

- `scripts/run-codex-acp-server.ts` — run a Codex ACP test server.
- `scripts/run-openai-agent-server.ts` — run an OpenAI agent test server.
- `scripts/test-codex-acp-client.ts` — test Codex ACP client connectivity.
- `scripts/test-openai-agent-client.ts` — test OpenAI agent client connectivity.
- `npm run test:e2e:providers` — run live provider e2e tests (requires API keys in env).

Do not introduce new tools or services without a clear justification and minimal footprint.

## 10. Constraints / do-not-touch areas

Do not change, unless a task explicitly requires it:

**Public API contracts:**

- The exports from `src/index.ts`: `McpAgenticServer`, `McpAgenticServerConfig`, `AgentHandler`, `Agent`, `AgentResult`, `AgentEvent`, `AgentChunk`, `AgentFinal`, `AgentError`, `PromptOpts`, `StreamOpts`, `WorkerConfig`.
- Provider layer exports from `src/index.ts`: `AIProvider`, `AIProviderResult`, `RuntimeParams`, `ProviderConfig`, `ChatMessage` (types); `ProviderRegistry`, `ProviderInfo`, `mergeRuntimeParams` (values/types); `OpenAIProvider`, `AnthropicProvider`, `GoogleGeminiProvider` (classes); `MultiProviderCompanionAgent`, `MultiProviderCompanionConfig` (class/type).
- The 8 MCP tool names, their input schemas (defined via Zod in `src/types.ts`), and their response shapes.
- The `AgentExecutor` interface in `src/executor/AgentExecutor.ts`.

**Shared types:**

- `BridgeError` categories and their retryability defaults.
- `BridgeErrorType` union type.
- `AIProvider` interface in `src/provider/AIProvider.ts` — the contract all provider implementations must satisfy.
- `RuntimeParams` type in `src/provider/AIProvider.ts` — the common parameter shape used across providers, MCP tool schemas, and the agent layer.

**Generated or vendor files:**

Do not manually edit:
- `out/` directory (generated by esbuild and tsc).
- `package-lock.json` or `yarn.lock` (unless the change is a direct result of `npm install`).
- `node_modules/`.

## 11. Performance & resource guidelines

Avoid algorithms worse than O(n log n) for large collections unless justified.

Be mindful of:
- **Session reaper overhead** — the `InProcessExecutor` runs a periodic reaper (`setInterval`) to clean expired sessions. The timer is `unref()`'d so it does not prevent process exit. Do not add blocking operations to the reaper loop.
- **Backpressure limits** — `maxConcurrentRequests` (default: 50) gates all tool handler calls. Exceeding this returns a retryable transport error. Do not bypass the `withBackpressure()` wrapper.
- **Input validation costs** — `Buffer.byteLength()` is called on every prompt and metadata payload. Keep validation lightweight.
- **StdioBus transport** — worker communication goes through stdin/stdout of child processes. Avoid large payloads that could saturate the pipe buffer.
- **Executor resolution caching** — `agentExecutorCache` maps agent IDs to executors. It is cleared on `register()` / `registerWorker()` calls. Do not introduce cache invalidation bugs.

If a task touches the executor resolution path, session lifecycle, or backpressure logic, summarize your reasoning and trade-offs.

## 12. Monorepo & nested AGENTS.md

This repository is a single package, not a monorepo. Nested `AGENTS.md` files are not currently used.

Rule: follow the instructions of the closest `AGENTS.md` to the file you are editing.

If a nested `AGENTS.md` is added in the future:
- Local (nested) rules take precedence for that subproject.
- Global constraints in this root file still apply for:
  - Security.
  - Secrets handling.
  - Destructive operations.

## 13. Multi-agent / personas (if applicable)

This repository does not currently use specialized agent personas. If you are a specialized agent, follow your persona rules in addition to this file:

- `@dev-agent`: focus on implementation and tests.
- `@test-agent`: focus on test coverage and edge cases; do not change runtime code unless fixing flakiness.
- `@security-agent`: focus on security review and hardening; minimize functional changes.

If rules conflict, security > correctness > convenience.

## 14. Definition of Done (checklist)

Before considering a task complete, ensure:

- [ ] Code compiles: `npm run typecheck` passes with no errors.
- [ ] Project builds: `npm run build` succeeds.
- [ ] Unit tests pass: `npm run test:unit` passes.
- [ ] Lint/format pass: `npm run typecheck` reports no issues (this project uses tsc strict mode as its primary lint gate).
- [ ] No constraints from section 10 are violated.
- [ ] New/changed behavior is covered by tests.
- [ ] Changes are documented (changelog/docs/PR description).
- [ ] No secrets or sensitive data added to the repo.
- [ ] stdout remains reserved for MCP wire protocol only.

If any item is not satisfied, the task is not done.
