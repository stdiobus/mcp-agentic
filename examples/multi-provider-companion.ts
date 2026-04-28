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
 * as an MCP Agentic server over stdio.
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
 * # Uses multi-provider.config.json from examples/ directory
 * OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/multi-provider-companion.ts
 *
 * # Explicit config path
 * OPENAI_API_KEY=sk-... COMPANION_CONFIG=./my-config.json npx tsx examples/multi-provider-companion.ts
 * ```
 *
 * ## MCP config (mcp.json)
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "multi-companion": {
 *       "command": "npx",
 *       "args": ["tsx", "examples/multi-provider-companion.ts"],
 *       "env": {
 *         "OPENAI_API_KEY": "sk-...",
 *         "ANTHROPIC_API_KEY": "sk-ant-...",
 *         "GOOGLE_AI_API_KEY": "AIza...",
 *         "COMPANION_CONFIG": "./examples/multi-provider.config.json"
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
  MultiProviderCompanionAgent,
  ProviderRegistry,
  OpenAIProvider,
  AnthropicProvider,
  GoogleGeminiProvider,
} from '../src/index.js';
import type { RuntimeParams, ProviderConfig } from '../src/index.js';

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

/** Mapping from provider id to the env var holding its API key. */
const PROVIDER_ENV_KEYS: Record<string, string> = {
  'openai': 'OPENAI_API_KEY',
  'anthropic': 'ANTHROPIC_API_KEY',
  'google-gemini': 'GOOGLE_AI_API_KEY',
};

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
 * Create a ProviderConfig for a given provider id.
 *
 * @param providerId - The provider identifier.
 * @param apiKey - The API key from environment.
 * @param providerJson - Optional per-provider config from JSON.
 * @returns ProviderConfig ready for provider construction.
 */
function buildProviderConfig(
  providerId: string,
  apiKey: string,
  providerJson?: ProviderJsonConfig,
): ProviderConfig {
  return {
    credentials: { apiKey },
    models: providerJson?.models ?? DEFAULT_MODELS[providerId] ?? [],
    defaults: providerJson?.defaults,
  };
}

/**
 * Register all available providers into a ProviderRegistry.
 *
 * Only providers whose API key is present in the environment are registered.
 * Uses the async `create()` factory methods for dynamic SDK import.
 *
 * @param providersJson - Provider configurations from the JSON config file.
 * @returns Object with the registry and the id of the first registered provider.
 */
async function registerProviders(
  providersJson: Record<string, ProviderJsonConfig>,
): Promise<{ registry: ProviderRegistry; firstProviderId: string | null }> {
  const registry = new ProviderRegistry();
  let firstProviderId: string | null = null;

  // OpenAI
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey && openaiKey !== '${OPENAI_API_KEY}') {
    try {
      const config = buildProviderConfig('openai', openaiKey, providersJson['openai']);
      const provider = await OpenAIProvider.create(config);
      registry.register(provider);
      firstProviderId ??= 'openai';
      process.stderr.write(`[multi-provider] Registered OpenAI provider (models: ${config.models.join(', ')})\n`);
    } catch (err) {
      process.stderr.write(
        `[multi-provider] Warning: Failed to register OpenAI provider: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Anthropic
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey && anthropicKey !== '${ANTHROPIC_API_KEY}') {
    try {
      const config = buildProviderConfig('anthropic', anthropicKey, providersJson['anthropic']);
      const provider = await AnthropicProvider.create(config);
      registry.register(provider);
      firstProviderId ??= 'anthropic';
      process.stderr.write(`[multi-provider] Registered Anthropic provider (models: ${config.models.join(', ')})\n`);
    } catch (err) {
      process.stderr.write(
        `[multi-provider] Warning: Failed to register Anthropic provider: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Google Gemini
  const geminiKey = process.env['GOOGLE_AI_API_KEY'];
  if (geminiKey && geminiKey !== '${GOOGLE_AI_API_KEY}') {
    try {
      const config = buildProviderConfig('google-gemini', geminiKey, providersJson['google-gemini']);
      const provider = await GoogleGeminiProvider.create(config);
      registry.register(provider);
      firstProviderId ??= 'google-gemini';
      process.stderr.write(`[multi-provider] Registered Google Gemini provider (models: ${config.models.join(', ')})\n`);
    } catch (err) {
      process.stderr.write(
        `[multi-provider] Warning: Failed to register Google Gemini provider: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return { registry, firstProviderId };
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

  // Register providers based on available API keys
  const { registry, firstProviderId } = await registerProviders(json.providers ?? {});

  if (!firstProviderId) {
    process.stderr.write(
      '[multi-provider] Error: No AI providers could be registered.\n' +
      '[multi-provider] Set at least one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY\n',
    );
    process.exit(1);
  }

  // Resolve default provider: config preference > first available
  const defaultProviderId = (json.defaultProvider && registry.has(json.defaultProvider))
    ? json.defaultProvider
    : firstProviderId;

  // Create the multi-provider agent
  const agent = new MultiProviderCompanionAgent({
    id: name,
    defaultProviderId,
    registry,
    capabilities,
    systemPrompt,
    defaults: globalDefaults,
  });

  // Create and start the MCP server
  const server = new McpAgenticServer({ defaultAgentId: name })
    .register(agent);

  const shutdown = async (): Promise<void> => {
    try { await server.close(); } catch { /* best-effort */ }
    process.exitCode = 0;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.startStdio();

    const providers = registry.list();
    process.stderr.write(
      `[multi-provider] Started — role: "${role}", agent: "${name}", ` +
      `default provider: ${defaultProviderId}, ` +
      `providers: ${providers.map((p) => p.id).join(', ')}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[multi-provider] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

main();
