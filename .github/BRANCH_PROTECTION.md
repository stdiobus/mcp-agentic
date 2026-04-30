# Branch Protection — Recommended Configuration

Apply these settings via **Settings → Branches → Branch protection rules** in the GitHub repository.

## `main` Branch

| Setting | Value |
|---------|-------|
| Require a pull request before merging | ✓ |
| Required approving reviews | 1 (increase to 2 for teams > 3) |
| Dismiss stale pull request approvals when new commits are pushed | ✓ |
| Require review from Code Owners | ✓ |
| Require status checks to pass before merging | ✓ |
| **Required status checks** | `Typecheck (Node 20.x)`, `Typecheck (Node 22.x)`, `Unit Tests (Node 20.x)`, `Unit Tests (Node 22.x)`, `Build (Node 20.x)`, `Build (Node 22.x)`, `E2E Tests (Node 22.x)`, `Package Dry Run`, `PR Title Format`, `Secrets & Sensitive Files` |
| Require branches to be up to date before merging | ✓ |
| Require conversation resolution before merging | ✓ |
| Require signed commits | ✓ (recommended) |
| Require linear history | ✓ (squash or rebase merges only) |
| Include administrators | ✓ |
| Restrict who can push to matching branches | ✓ (release automation only) |
| Allow force pushes | ❌ |
| Allow deletions | ❌ |

## `develop` Branch

| Setting | Value |
|---------|-------|
| Require a pull request before merging | ✓ |
| Required approving reviews | 1 |
| Dismiss stale pull request approvals when new commits are pushed | ✓ |
| Require status checks to pass before merging | ✓ |
| **Required status checks** | `Typecheck (Node 22.x)`, `Unit Tests (Node 22.x)`, `Build (Node 22.x)`, `PR Title Format` |
| Require branches to be up to date before merging | ✓ |
| Allow force pushes | ❌ |
| Allow deletions | ❌ |

## Release Flow

The release process is fully automated via two workflows:

```
1. Developer merges PRs into main (with conventional commit titles)
2. release-please.yml creates/updates a "Release PR" automatically
   - Bumps version in package.json based on commit types
   - Generates CHANGELOG.md entries
   - Accumulates changes until maintainer decides to release
3. Maintainer reviews and merges the Release PR
4. release-please creates a GitHub Release + git tag (e.g., v1.2.0)
5. release.yml triggers on the GitHub Release:
   - Validates version tag ↔ package.json consistency
   - Runs full CI pipeline (typecheck + tests + build + e2e)
   - Checks npm registry for duplicate version
   - Waits for manual approval (npm-publish environment)
   - Publishes to npm with provenance attestation
```

**Key safety properties:**
- Version bumps are deterministic from conventional commits (no manual version editing)
- You cannot publish without passing full CI
- You cannot republish an existing version (pre-publish registry check)
- npm provenance cryptographically links the package to the source commit
- The npm-publish environment requires manual approval before publish

## GitHub Environments

### `npm-publish`

Used by the Release workflow. Configure in **Settings → Environments**:
- **Required reviewers**: At least 1 maintainer must approve the deployment
- **Wait timer**: 0 (manual approval is sufficient)
- **Deployment branches**: Only `main`
- **Secrets**: `NPM_TOKEN` — npm automation token with `publish` scope

### `provider-e2e`

Used by the Provider E2E workflow. Configure in **Settings → Environments**:
- **Secrets**: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`
- **Deployment branches**: `main`, `develop`

## Repository Secrets

| Secret | Used By | Description |
|--------|---------|-------------|
| `NPM_TOKEN` | Release workflow | npm automation token with `publish` scope for `@stdiobus/mcp-agentic` |
| `OPENAI_API_KEY` | Provider E2E | OpenAI API key for live integration tests |
| `ANTHROPIC_API_KEY` | Provider E2E | Anthropic API key for live integration tests |
| `GOOGLE_AI_API_KEY` | Provider E2E | Google AI API key for live integration tests |

`GITHUB_TOKEN` is automatically provided by GitHub Actions and does not need manual configuration. `release-please` uses it to create Release PRs and GitHub Releases.

## CODEOWNERS Setup

Replace `YOUR_GITHUB_USERNAME` in `.github/CODEOWNERS` and `.github/dependabot.yml` with your actual GitHub username. Alternatively, create a team `core` in the `stdiobus` organization and use `@stdiobus/core`.
