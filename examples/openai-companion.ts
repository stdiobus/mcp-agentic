/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI Companion Agent — Real MCP Server Example
 *
 * A fully configurable AI companion powered by OpenAI via the official
 * `openai` SDK, exposed as an MCP Agentic server over stdio. Uses the
 * {@link MultiProviderCompanionAgent} with a single OpenAI provider for
 * full runtime parameter control through MCP tools.
 *
 * Configuration is split by concern:
 *
 * - **JSON file** — behavior: role, name, system prompt, capabilities, model,
 *   default RuntimeParams
 * - **Environment** — secrets: API key only
 *
 * The JSON config can be committed to a repo and shared across a team.
 * The API key stays in env variables / secret managers.
 *
 * ## Configuration
 *
 * ### JSON config file (`companion.config.json`)
 *
 * ```json
 * {
 *   "name": "companion",
 *   "role": "Lead Solution Architect",
 *   "model": "gpt-4o-mini",
 *   "capabilities": ["architecture", "code-review", "design"],
 *   "systemPrompt": null,
 *   "defaults": { "temperature": 0.7 }
 * }
 * ```
 *
 * | Field          | Required | Default                       | Description                                          |
 * |----------------|----------|-------------------------------|------------------------------------------------------|
 * | `name`         | no       | `"companion"`                 | Agent ID for MCP routing                             |
 * | `role`         | no       | `"AI Companion"`              | Who the companion is — drives default system prompt   |
 * | `model`        | no       | `"gpt-4o-mini"`               | OpenAI model identifier                              |
 * | `capabilities` | no       | `["analysis","conversation"]` | Capabilities for agents_discover                     |
 * | `systemPrompt` | no       | `null` (built from role)      | Full system prompt override; `null` = auto-build     |
 * | `defaults`     | no       | `{}`                          | Default RuntimeParams (temperature, maxTokens, etc.) |
 *
 * When `systemPrompt` is `null`, a default prompt is built from `role`.
 * Set it to a string to take full control over the companion's instructions.
 *
 * ### Environment variables
 *
 * | Variable         | Required | Description     |
 * |------------------|----------|-----------------|
 * | `OPENAI_API_KEY` | yes      | OpenAI API key  |
 *
 * ### Config file resolution
 *
 * The script looks for the config file in this order:
 * 1. `COMPANION_CONFIG` env var (explicit path)
 * 2. `companion.config.json` next to this script
 * 3. `companion.config.json` in the current working directory
 * 4. Falls back to defaults if no file found
 *
 * ## Usage
 *
 * ```bash
 * # Uses companion.config.json from examples/ directory
 * OPENAI_API_KEY=sk-... npx tsx examples/openai-companion.ts
 *
 * # Explicit config path
 * OPENAI_API_KEY=sk-... COMPANION_CONFIG=./my-config.json npx tsx examples/openai-companion.ts
 * ```
 *
 * ## MCP config (mcp.json)
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "companion": {
 *       "command": "npx",
 *       "args": ["tsx", "examples/openai-companion.ts"],
 *       "env": {
 *         "OPENAI_API_KEY": "sk-...",
 *         "COMPANION_CONFIG": "./examples/companion.config.json"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * ## MCP tool usage examples
 *
 * ### Prompt with runtime parameter overrides
 * ```
 * sessions_prompt({ sessionId: "...", prompt: "Hello", runtimeParams: { temperature: 0, model: "gpt-4o" } })
 * ```
 *
 * ### One-shot delegation with runtimeParams
 * ```
 * tasks_delegate({ prompt: "Explain MCP", runtimeParams: { maxTokens: 100 } })
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
} from '../src/index.js';
import type { RuntimeParams } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Companion Configuration ─────────────────────────────────────

/** JSON config file shape. All fields optional — defaults applied at load. */
interface CompanionJsonConfig {
  name?: string;
  role?: string;
  model?: string;
  capabilities?: string[];
  systemPrompt?: string | null;
  defaults?: RuntimeParams;
}

/** Resolved runtime config with all fields populated. */
interface CompanionConfig {
  apiKey: string;
  model: string;
  name: string;
  role: string;
  systemPrompt: string;
  capabilities: string[];
  defaults: RuntimeParams;
}

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
 * 2. companion.config.json next to this script
 * 3. companion.config.json in cwd
 */
function resolveConfigPath(): string | null {
  const envPath = process.env['COMPANION_CONFIG'];
  if (envPath) {
    const resolved = resolve(envPath);
    if (existsSync(resolved)) return resolved;
    process.stderr.write(`[companion] Warning: COMPANION_CONFIG="${envPath}" not found, trying defaults\n`);
  }

  const scriptLocal = join(__dirname, 'companion.config.json');
  if (existsSync(scriptLocal)) return scriptLocal;

  const cwdLocal = resolve('companion.config.json');
  if (existsSync(cwdLocal)) return cwdLocal;

  return null;
}

/** Load JSON config file, or return empty object if not found. */
function loadJsonConfig(): CompanionJsonConfig {
  const configPath = resolveConfigPath();

  if (!configPath) {
    process.stderr.write('[companion] No config file found, using defaults\n');
    return {};
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as CompanionJsonConfig;
    process.stderr.write(`[companion] Loaded config from ${configPath}\n`);
    return parsed;
  } catch (err) {
    process.stderr.write(
      `[companion] Warning: Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return {};
  }
}

/** Merge JSON config + env into a resolved runtime config. */
function loadConfig(): CompanionConfig {
  // Secrets from env only
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey || apiKey === '${OPENAI_API_KEY}') {
    process.stderr.write('[companion] Error: OPENAI_API_KEY environment variable is required\n');
    process.exit(1);
  }

  // Behavior from JSON
  const json = loadJsonConfig();

  const name = json.name ?? 'companion';
  const role = json.role ?? 'AI Companion';
  const model = json.model ?? 'gpt-4o-mini';
  const capabilities = json.capabilities ?? ['analysis', 'conversation'];
  const systemPrompt = (typeof json.systemPrompt === 'string')
    ? json.systemPrompt
    : buildSystemPrompt(role);
  const defaults = json.defaults ?? {};

  return { apiKey, model, name, role, systemPrompt, capabilities, defaults };
}

// ── Start Server ────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  // Create OpenAI provider via the official SDK
  const openaiProvider = await OpenAIProvider.create({
    credentials: { apiKey: config.apiKey },
    models: [config.model],
    defaults: { model: config.model },
  });

  // Set up provider registry with OpenAI
  const registry = new ProviderRegistry();
  registry.register(openaiProvider);

  // Create the multi-provider agent (single provider in this case)
  const agent = new MultiProviderCompanionAgent({
    id: config.name,
    defaultProviderId: 'openai',
    registry,
    capabilities: config.capabilities,
    systemPrompt: config.systemPrompt,
    defaults: config.defaults,
  });

  const server = new McpAgenticServer({ defaultAgentId: config.name })
    .register(agent);

  const shutdown = async (): Promise<void> => {
    try { await server.close(); } catch { /* best-effort */ }
    process.exitCode = 0;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await server.startStdio();
    process.stderr.write(
      `[companion] Started — role: "${config.role}", agent: "${config.name}", model: ${config.model}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[companion] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

main();
