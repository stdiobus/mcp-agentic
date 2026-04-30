# Contributing to @stdiobus/mcp-agentic

Thank you for your interest in contributing to `@stdiobus/mcp-agentic`. This document explains how to get involved, what we expect from contributions, and how the review process works.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Quality Requirements](#quality-requirements)
- [Reporting Issues](#reporting-issues)
- [Security Vulnerabilities](#security-vulnerabilities)
- [License](#license)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to **raman@stdiobus.com**.

## Getting Started

### Before You Contribute

1. **Check existing issues** — search [open issues](https://github.com/stdiobus/mcp-agentic/issues) to see if someone is already working on what you have in mind.
2. **Open a discussion or issue first** for non-trivial changes. This avoids wasted effort if the change doesn't align with the project direction. Bug fixes and documentation improvements can go straight to a PR.
3. **Read the architecture** — the [README](README.md) and `AGENTS.md` describe the project structure, key invariants, and design decisions. Understanding these before coding will save time.

### What We're Looking For

All contributions are welcome, including:

- Bug fixes with regression tests
- Documentation improvements and corrections
- New test coverage for uncovered edge cases
- Performance improvements with benchmarks
- New features (please discuss first via an issue)

## Development Setup

### Prerequisites

- **Node.js >= 20.0.0** (`node --version` to check)
- **npm** (ships with Node.js)
- **Git**

### Setup

```bash
# Fork and clone the repository
git clone https://github.com/<your-username>/mcp-agentic.git
cd mcp-agentic

# Install dependencies
npm install

# Verify everything works
npm run typecheck
npm run test:unit
npm run build
```

### Project Structure

```
src/                     Production source code (TypeScript, ESM-only)
  server/                McpAgenticServer — single public entry point
  agent/                 AgentHandler interface + MultiProviderCompanionAgent
  executor/              Execution backends (InProcess, Worker)
  provider/              AI provider abstraction (OpenAI, Anthropic, Gemini)
  mcp/                   MCP tool definitions and handlers
  errors/                BridgeError class and error mapping
  observability/         Structured logging and correlation IDs
  types.ts               Zod schemas — single source of truth for tool inputs
test/
  unit/                  Unit tests (mirrors src/ structure)
  e2e/                   End-to-end tests
  __mocks__/             Manual mocks for external SDKs
```

### Key Commands

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | Type check without emitting (tsc --noEmit) |
| `npm run test:unit` | Run unit tests via Jest |
| `npm run test:e2e` | Run end-to-end tests |
| `npm run test:all` | Unit + e2e tests |
| `npm run test:coverage` | Unit tests with coverage report |
| `npm run build` | Full build: clean + esbuild + tsc declarations |
| `npm run clean` | Remove build artifacts |


### Optional: Provider SDKs

If your contribution involves the provider layer, install the relevant SDK(s):

```bash
npm install openai                  # OpenAI provider
npm install @anthropic-ai/sdk       # Anthropic provider
npm install @google/generative-ai   # Google Gemini provider
```

These are optional peer dependencies. Unit tests use manual mocks in `test/__mocks__/` and do not require real SDKs installed.

## Making Changes

### Branch Naming

Create a branch from `main` using one of these prefixes:

- `feature/` — new functionality
- `fix/` — bug fixes
- `docs/` — documentation only
- `chore/` — maintenance, dependencies, CI
- `refactor/` — code restructuring without behavior change

Example: `feature/add-timeout-to-session-reaper`

### Code Conventions

This project uses TypeScript strict mode with all strict flags enabled. Follow these conventions:

- **Imports** use `.js` extensions (required for NodeNext module resolution)
- **Single quotes**, semicolons
- **Import order**: Node.js builtins → external packages → internal modules. Type-only imports use `import type`
- **Section separators**: `// ── Section Name ───────────`
- **JSDoc comments** on public APIs
- **Errors** use `BridgeError` with typed categories — never throw raw strings
- **Logging** goes to stderr only — stdout is reserved for the MCP wire protocol

When in doubt, follow the patterns in the surrounding code.

### Testing Requirements

Every code change must include tests:

- **Bug fixes** — add a regression test that fails without the fix and passes with it
- **New features** — add unit tests covering the happy path and relevant edge cases
- **Refactors** — existing tests must continue to pass; add tests if coverage drops

Test files live in `test/unit/` and mirror the `src/` directory structure. Use the shared `createMockExecutor()` factory from `test/unit/mcp/tools/_mockExecutor.ts` for tool handler tests.

**Coverage thresholds are enforced in CI:**

| Metric | Minimum |
|--------|---------|
| Lines | 85% |
| Branches | 80% |
| Functions | 85% |
| Statements | 85% |

PRs that drop coverage below these thresholds will not be merged.

### Documentation Requirements

If your change affects user-facing behavior, update the relevant documentation:

- **New or changed MCP tool behavior** — update the tool description in `src/mcp/tool-definitions.ts` and the README
- **New public API** — add JSDoc comments and update `README.md` usage examples
- **Configuration changes** — update the README configuration section
- **New provider or executor** — add usage examples

Documentation-only PRs are welcome and appreciated.

## Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short description>

<optional body>
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `chore` | Maintenance (deps, CI, build) |

### Scope (optional)

Use the affected area: `server`, `executor`, `provider`, `mcp`, `agent`, `errors`, `cli`, `observability`.

### Examples

```
feat(provider): add request retry with exponential backoff
fix(executor): prevent session leak on prompt timeout
docs: update provider setup instructions in README
test(agent): add edge case coverage for empty prompt handling
chore(deps): update esbuild to 0.25.x
```

Keep commits small and focused. Each commit should represent one logical change.

## Pull Request Process

### 1. Before Submitting

Run the full quality gate locally:

```bash
npm run typecheck        # Must pass with zero errors
npm run test:unit        # Must pass, coverage thresholds enforced
npm run build            # Must succeed
npm run test:e2e         # Run if your change affects runtime behavior
```

### 2. Open the PR

- Target the `main` branch
- Fill out the [PR template](.github/pull_request_template.md) completely
- Title format: `<type>(<scope>): <short description>` (same as commit convention)
- Link related issues with `Closes #123`

### 3. Review Process

- All PRs require approval from at least one member of `@stdiobus/core` before merging
- CI must pass (typecheck, unit tests, build, e2e tests)
- Coverage thresholds must be met
- Reviewers may request changes — please address all feedback before re-requesting review

### 4. After Approval

A `@stdiobus/core` maintainer will merge your PR. Do not merge your own PRs unless you are a core maintainer.

## Quality Requirements

These are enforced by CI and are non-negotiable:

- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run test:unit` passes with coverage above thresholds (85% lines, 80% branches, 85% functions, 85% statements)
- [ ] `npm run build` succeeds and produces expected artifacts
- [ ] No secrets, tokens, or credentials in the code
- [ ] stdout remains reserved for MCP wire protocol only
- [ ] Public API contracts unchanged (or change is intentional, discussed, and documented)
- [ ] `BridgeError` used for all domain errors (no raw string throws)
- [ ] New/changed behavior covered by tests

## Reporting Issues

Use the [issue templates](https://github.com/stdiobus/mcp-agentic/issues/new/choose):

- **Bug Report** — for reproducible bugs. Include version, Node.js version, executor type, and steps to reproduce.
- **Feature Request** — for new functionality. Describe the problem, proposed solution, and alternatives considered.

Please search existing issues before opening a new one.

## Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.**

Report security issues privately to **raman@stdiobus.com**. See [SECURITY.md](.github/SECURITY.md) for full details on our security policy and response timeline.

## License

By submitting a contribution to this project, you agree that your contribution will be licensed under the [Apache License 2.0](LICENSE), the same license that covers the project. You represent that you have the right to submit the contribution and that it does not violate any third-party rights.
