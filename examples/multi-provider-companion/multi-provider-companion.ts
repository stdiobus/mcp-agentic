/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multi-Provider Companion Agent — Real MCP Server Example
 *
 * A fully configurable AI companion that supports multiple AI providers
 * (OpenAI, Anthropic, Google Gemini) through their native SDKs, exposed
 * as an MCP Agentic server over stdio. Uses the Provider Factory API
 * ({@link openAI}, {@link anthropic}, {@link gemini} +
 * {@link createMultiProviderAgent}) for declarative setup with full
 * runtime parameter control through MCP tools.
 *
 * Configuration is split by concern:
 *
 * - **JSON file** — behavior: role, name, system prompt, capabilities,
 *   provider models, default parameters
 * - **Environment** — secrets: API keys only
 *
 * The JSON config can be committed to a repo and shared across a team.
 * API keys stay in env variables / secret managers.
 *
 * ## Configuration
 *
 * ### JSON config file (`multi-provider.config.json`)
 *
 * ```json
 * {
 *   "name": "multi-companion",
 *   "role": "Lead Solution Architect",
 *   "capabilities": ["architecture", "code-review"],
 *   "systemPrompt": null,
 *   "providers": {
 *     "openai": {
 *       "models": ["gpt-4o-mini", "gpt-4o"],
 *       "defaults": { "model": "gpt-4o-mini" }
 *     },
 *     "anthropic": {
 *       "models": ["claude-sonnet-4-20250514"],
 *       "defaults": { "model": "claude-sonnet-4-20250514" }
 *     },
 *     "google-gemini": {
 *       "models": ["gemini-2.0-flash"],
 *       "defaults": { "model": "gemini-2.0-flash" }
 *     }
 *   },
 *   "defaultProvider": "openai",
 *   "defaults": { "temperature": 0.7, "maxTokens": 4096 }
 * }
 * ```
 *
 * | Field             | Required | Default                       | Description                                          |
 * |-------------------|----------|-------------------------------|------------------------------------------------------|
 * | `name`            | no       | `"multi-companion"`           | Agent ID for MCP routing                             |
 * | `role`            | no       | `"AI Companion"`              | Who the companion is — drives default system prompt   |
 * | `capabilities`    | no       | `["analysis","conversation"]` | Capabilities for agents_discover                     |
 * | `systemPrompt`    | no       | `null` (built from role)      | Full system prompt override; `null` = auto-build     |
 * | `providers`       | no       | `{}`                          | Provider configurations keyed by provider id         |
 * | `defaultProvider` | no       | first available provider      | Default provider id when none specified in metadata  |
 * | `defaults`        | no       | `{}`                          | Global RuntimeParams defaults for all providers      |
 *
 * Providers are registered only when their API key is present in the
 * environment. If no API keys are set, the server exits with an error.
 *
 * ### Environment variables
 *
 * | Variable            | Required | Description              |
 * |---------------------|----------|--------------------------|
 * | `OPENAI_API_KEY`    | no*      | OpenAI API key           |
 * | `ANTHROPIC_API_KEY` | no*      | Anthropic API key        |
 * | `GOOGLE_AI_API_KEY` | no*      | Google Gemini API key    |
 *
 * *At least one API key must be provided.
 *
 * ### Config file resolution
 *
 * The script looks for the config file in this order:
 * 1. `COMPANION_CONFIG` env var (explicit path)
 * 2. `multi-provider.config.json` next to this script
 * 3. `multi-provider.config.json` in the current working directory
 * 4. Falls back to defaults if no file found
 *
 * ## Usage
 *
 * ```bash
 * # Uses multi-provider.config.json from examples/multi-provider-companion/ directory
 * OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/multi-provider-companion/multi-provider-companion.ts
 *
 * # Explicit config path
 * OPENAI_API_KEY=sk-... COMPANION_CONFIG=./my-config.json npx tsx examples/multi-provider-companion/multi-provider-companion.ts
 * ```
 *
 * ## MCP config (mcp.json)
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "multi-companion": {
 *       "command": "npx",
 *       "args": ["tsx", "examples/multi-provider-companion/multi-provider-companion.ts"],
 *       "env": {
 *         "OPENAI_API_KEY": "sk-...",
 *         "ANTHROPIC_API_KEY": "sk-ant-...",
 *         "GOOGLE_AI_API_KEY": "AIza...",
 *         "COMPANION_CONFIG": "./examples/multi-provider-companion/multi-provider.config.json"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * ## MCP tool usage examples
 *
 * ### Discover available providers
 * ```
 * agents_discover → { agents: [{ id: "multi-companion", providers: [{ id: "openai", models: [...] }, ...] }] }
 * ```
 *
 * ### Create session with a specific provider
 * ```
 * sessions_create({ agentId: "multi-companion", metadata: { provider: "anthropic" } })
 * ```
 *
 * ### Prompt with runtime parameter overrides
 * ```
 * sessions_prompt({ sessionId: "...", prompt: "Hello", runtimeParams: { temperature: 0, model: "gpt-4o" } })
 * ```
 *
 * ### One-shot delegation with runtimeParams
 * ```
 * tasks_delegate({ prompt: "Explain MCP", metadata: { provider: "google-gemini" }, runtimeParams: { maxTokens: 100 } })
 * ```
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  McpAgenticServer,
  openAI,
  anthropic,
  gemini,
  createMultiProviderAgent,
} from '../../src/index.js';
import type { AIProvider, RuntimeParams } from '../../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Configuration Types ─────────────────────────────────────────

/** Per-provider config in the JSON file. */
interface ProviderJsonConfig {
  models?: string[];
  defaults?: RuntimeParams;
}

/** JSON config file shape. All fields optional — defaults applied at load. */
interface MultiProviderJsonConfig {
  name?: string;
  role?: string;
  capabilities?: string[];
  systemPrompt?: string | null;
  providers?: Record<string, ProviderJsonConfig>;
  defaultProvider?: string;
  defaults?: RuntimeParams;
}

/** Default models when not specified in config. */
const DEFAULT_MODELS: Record<string, string[]> = {
  'openai': ['gpt-4o-mini'],
  'anthropic': ['claude-sonnet-4-20250514'],
  'google-gemini': ['gemini-2.0-flash'],
};

// ── Configuration Loading ───────────────────────────────────────

/** Build the default system prompt from the companion's role. */
function buildSystemPrompt(role: string): string {
  return [
    `You are a ${role}.`,
    '',
    'Your operating principles:',
    '- Be direct, concise, and practical.',
    '- Provide concrete solutions, not vague suggestions.',
    '- When reviewing code, focus on correctness, security, and maintainability.',
    '- When discussing architecture, reason about trade-offs explicitly.',
    '- Admit uncertainty rather than guessing. Say what you know and what you don\'t.',
    '- Adapt your depth to the question: simple questions get short answers, complex ones get thorough analysis.',
    '',
    'You maintain conversation context across turns within a session.',
    'You can handle any task within your domain of expertise.',
  ].join('\n');
}

/**
 * Resolve the config file path. Checks in order:
 * 1. COMPANION_CONFIG env var
 * 2. multi-provider.config.json next to this script
 * 3. multi-provider.config.json in cwd
 */
function resolveConfigPath(): string | null {
  const envPath = process.env['COMPANION_CONFIG'];
  if (envPath) {
    const resolved = resolve(envPath);
    if (existsSync(resolved)) return resolved;
    process.stderr.write(`[multi-provider] Warning: COMPANION_CONFIG="${envPath}" not found, trying defaults\n`);
  }

  const scriptLocal = join(__dirname, 'multi-provider.config.json');
  if (existsSync(scriptLocal)) return scriptLocal;

  const cwdLocal = resolve('multi-provider.config.json');
  if (existsSync(cwdLocal)) return cwdLocal;

  return null;
}

/** Load JSON config file, or return empty object if not found. */
function loadJsonConfig(): MultiProviderJsonConfig {
  const configPath = resolveConfigPath();

  if (!configPath) {
    process.stderr.write('[multi-provider] No config file found, using defaults\n');
    return {};
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as MultiProviderJsonConfig;
    process.stderr.write(`[multi-provider] Loaded config from ${configPath}\n`);
    return parsed;
  } catch (err) {
    process.stderr.write(
      `[multi-provider] Warning: Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return {};
  }
}

// ── Provider Registration ───────────────────────────────────────

/**
 * Mapping from provider id to:
 * - `envKey`: environment variable holding the API key
 * - `factory`: declarative provider factory from the Provider Factory API
 */
const PROVIDER_DEFS: Record<string, { envKey: string; factory: (opts: { apiKey: string; models: string[]; defaults?: RuntimeParams }) => AIProvider }> = {
  'openai': { envKey: 'OPENAI_API_KEY', factory: openAI },
  'anthropic': { envKey: 'ANTHROPIC_API_KEY', factory: anthropic },
  'google-gemini': { envKey: 'GOOGLE_AI_API_KEY', factory: gemini },
};

/**
 * Create AIProvider instances for all providers whose API key is present
 * in the environment. Uses the declarative factory API — each factory
 * validates options via Zod and loads its SDK lazily.
 *
 * @param providersJson - Per-provider configurations from the JSON config file.
 * @returns Array of created providers and the id of the first one registered.
 */
function createProviders(
  providersJson: Record<string, ProviderJsonConfig>,
): { providers: AIProvider[]; firstProviderId: string | null } {
  const providers: AIProvider[] = [];
  let firstProviderId: string | null = null;

  for (const [providerId, def] of Object.entries(PROVIDER_DEFS)) {
    const apiKey = process.env[def.envKey];
    if (!apiKey || apiKey === `\${${def.envKey}}`) continue;

    const providerJson = providersJson[providerId];
    const models = providerJson?.models ?? DEFAULT_MODELS[providerId] ?? [];

    // Skip providers with no models configured
    if (models.length === 0) continue;

    try {
      const provider = def.factory({
        apiKey,
        models: models as [string, ...string[]],
        defaults: providerJson?.defaults,
      });
      providers.push(provider);
      firstProviderId ??= providerId;
      process.stderr.write(`[multi-provider] Registered ${providerId} provider (models: ${models.join(', ')})\n`);
    } catch (err) {
      process.stderr.write(
        `[multi-provider] Warning: Failed to register ${providerId} provider: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return { providers, firstProviderId };
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const json = loadJsonConfig();

  const name = json.name ?? 'multi-companion';
  const role = json.role ?? 'AI Companion';
  const capabilities = json.capabilities ?? ['analysis', 'conversation'];
  const systemPrompt = (typeof json.systemPrompt === 'string')
    ? json.systemPrompt
    : buildSystemPrompt(role);
  const globalDefaults = json.defaults ?? {};

  // Create providers based on available API keys using the factory API.
  // Each factory validates options via Zod and loads its SDK lazily.
  const { providers, firstProviderId } = createProviders(json.providers ?? {});

  if (!firstProviderId || providers.length === 0) {
    process.stderr.write(
      '[multi-provider] Error: No AI providers could be registered.\n' +
      '[multi-provider] Set at least one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY\n',
    );
    process.exit(1);
  }

  // Resolve default provider: config preference > first available
  const defaultProviderId = (json.defaultProvider && providers.some(p => p.id === json.defaultProvider))
    ? json.defaultProvider
    : firstProviderId;

  // Create the multi-provider agent via the helper.
  // createMultiProviderAgent handles ProviderRegistry creation internally.
  const agent = createMultiProviderAgent({
    id: name,
    providers,
    defaultProviderId,
    capabilities,
    systemPrompt,
    defaults: globalDefaults,
  });

  // Pass the agent directly via the config — no separate .register() needed.
  const server = new McpAgenticServer({
    agents: [agent],
    defaultAgentId: name,
  });

  const shutdown = async (): Promise<void> => {
    try { await server.close(); } catch { /* best-effort */ }
    process.exitCode = 0;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.start();
    process.stderr.write(
      `[multi-provider] Started — role: "${role}", agent: "${name}", ` +
      `default provider: ${defaultProviderId}, ` +
      `providers: ${providers.map(p => p.id).join(', ')}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[multi-provider] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

main();
