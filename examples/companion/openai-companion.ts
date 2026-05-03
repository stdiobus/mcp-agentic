/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI Companion Agent — Real MCP Server Example
 *
 * A fully configurable AI companion powered by OpenAI, exposed as an
 * MCP Agentic server over stdio. Implements {@link AgentHandler} directly
 * with full control over the prompt pipeline:
 *
 *   MCP Client → AgentHandler.prompt() → [before LLM] → provider.complete() → [after LLM] → response
 *
 * This is the recommended pattern for agents that need to do work before
 * and/or after the LLM call — tool execution, RAG retrieval, context
 * enrichment, response post-processing, logging, etc.
 *
 * The agent uses {@link openAI} factory to create the provider and manages
 * conversation history, system prompt, and runtime parameters itself.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │  AgentHandler (this file)                                   │
 * │                                                             │
 * │  onSessionCreate() → init session state                     │
 * │                                                             │
 * │  prompt(sessionId, input)                                   │
 * │    ├── beforeLLM(input, session)     ← enrich / tools / RAG │
 * │    ├── provider.complete(messages)   ← OpenAI API call      │
 * │    ├── afterLLM(result, session)     ← parse / tools / log  │
 * │    └── return AgentResult                                   │
 * │                                                             │
 * │  onSessionClose() → cleanup                                 │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Where to add custom logic
 *
 * **Before LLM** (`beforeLLM` function):
 * - Call MCP tools on other servers (e.g., search, database lookup)
 * - RAG: retrieve relevant documents and inject into context
 * - Input validation, content filtering, PII redaction
 * - Dynamic system prompt construction based on user intent
 *
 * **After LLM** (`afterLLM` function):
 * - Parse structured output (JSON, code blocks, action items)
 * - Execute tool calls from the LLM response (agentic loop)
 * - Save to memory / knowledge base
 * - Logging, metrics, audit trail
 * - Response formatting, citation injection
 *
 * ## Example: adding an MCP tool call before LLM
 *
 * ```typescript
 * // In beforeLLM(), call another MCP server's tool for context:
 * //
 * // import { Client } from '@modelcontextprotocol/sdk/client/index.js';
 * // import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
 * //
 * // const transport = new StdioClientTransport({ command: 'npx', args: ['my-search-server'] });
 * // const searchClient = new Client({ name: 'search', version: '1.0.0' });
 * // await searchClient.connect(transport);
 * //
 * // const results = await searchClient.callTool({
 * //   name: 'search_documents',
 * //   arguments: { query: input, limit: 5 },
 * // });
 * //
 * // // Inject search results into the prompt context
 * // const context = results.content[0].text;
 * // return `Context:\n${context}\n\nUser question: ${input}`;
 * ```
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
 * ### Environment variables
 *
 * | Variable         | Required | Description     |
 * |------------------|----------|-----------------|
 * | `OPENAI_API_KEY` | yes      | OpenAI API key  |
 *
 * ## Usage
 *
 * ```bash
 * OPENAI_API_KEY=sk-... npx tsx examples/companion/openai-companion.ts
 * ```
 *
 * ## MCP config (mcp.json)
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "companion": {
 *       "command": "npx",
 *       "args": ["tsx", "examples/companion/openai-companion.ts"],
 *       "env": {
 *         "OPENAI_API_KEY": "sk-...",
 *         "COMPANION_CONFIG": "./examples/companion/companion.config.json"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * ## MCP tool usage examples
 *
 * ### Discover the companion agent and its provider
 * ```
 * agents_discover → { agents: [{ id: "companion", providers: [{ id: "openai", models: ["gpt-4o-mini"] }] }] }
 * ```
 *
 * ### Create a session
 * ```
 * sessions_create → { sessionId: "..." }
 * ```
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
  openAI,
  ProviderRegistry,
  mergeRuntimeParams,
} from '@stdiobus/mcp-agentic';
import type {
  AgentHandler,
  AgentResult,
  PromptOpts,
  AIProvider,
  ChatMessage,
  RuntimeParams,
} from '@stdiobus/mcp-agentic';

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

// ── Per-session state ───────────────────────────────────────────

/** State maintained for each active session. */
interface SessionState {
  /** Conversation history (user + assistant messages). */
  messages: ChatMessage[];
  /** Session-level RuntimeParams (from metadata.runtimeParams at creation). */
  sessionParams: RuntimeParams;
  /** Ephemeral prompt-level params, set before prompt() and cleared after. */
  pendingPromptParams: RuntimeParams | undefined;
}

// ── Helpers ─────────────────────────────────────────────────────

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
  const defaults: RuntimeParams = { model, ...json.defaults };

  return { apiKey, model, name, role, systemPrompt, capabilities, defaults };
}

// ── Before / After LLM hooks ────────────────────────────────────

/**
 * Pre-processing hook — runs before every LLM call.
 *
 * This is where you add custom logic that enriches the prompt context:
 * - Call MCP tools on other servers (search, database, file system)
 * - RAG: retrieve relevant documents and inject into the prompt
 * - Input validation, content filtering, PII redaction
 * - Dynamic system prompt construction based on user intent
 * - Rate limiting, quota checks
 *
 * @param input - Raw user prompt from the MCP client.
 * @param session - Current session state (conversation history, params).
 * @returns Enriched input string to send to the LLM.
 *
 * @example Adding RAG context via an MCP tool call:
 * ```typescript
 * async function beforeLLM(input: string, session: SessionState): Promise<string> {
 *   // Call a search MCP server to find relevant documents
 *   const results = await searchClient.callTool({
 *     name: 'search_documents',
 *     arguments: { query: input, limit: 5 },
 *   });
 *   const context = results.content[0].text;
 *
 *   // Inject retrieved context into the prompt
 *   return `Relevant context:\n${context}\n\nUser question: ${input}`;
 * }
 * ```
 */
async function beforeLLM(input: string, _session: SessionState): Promise<string> {
  // Default: pass through unchanged.
  // Replace this with your pre-processing logic.
  return input;
}

/**
 * Post-processing hook — runs after every LLM response.
 *
 * This is where you add custom logic that processes the LLM output:
 * - Parse structured output (JSON, code blocks, action items)
 * - Execute tool calls from the LLM response (agentic tool-use loop)
 * - Save to memory / knowledge base / vector store
 * - Logging, metrics, audit trail
 * - Response formatting, citation injection
 * - Content safety filtering on output
 *
 * @param text - Raw text response from the LLM.
 * @param input - Original user input (for correlation).
 * @param session - Current session state.
 * @returns Processed text to return to the MCP client.
 *
 * @example Executing tool calls from LLM response:
 * ```typescript
 * async function afterLLM(text: string, input: string, session: SessionState): Promise<string> {
 *   // Check if the LLM wants to call a tool
 *   if (text.startsWith('TOOL_CALL:')) {
 *     const toolName = text.split(':')[1].trim();
 *     const toolResult = await toolClient.callTool({
 *       name: toolName,
 *       arguments: { query: input },
 *     });
 *     // Feed tool result back to LLM for final answer
 *     // (this creates an agentic loop)
 *     return toolResult.content[0].text;
 *   }
 *   return text;
 * }
 * ```
 */
async function afterLLM(text: string, _input: string, _session: SessionState): Promise<string> {
  // Default: pass through unchanged.
  // Replace this with your post-processing logic.
  return text;
}

// ── Companion Agent ─────────────────────────────────────────────

/**
 * Create the companion AgentHandler.
 *
 * This is a full AgentHandler implementation that:
 * 1. Manages per-session conversation history
 * 2. Supports runtime parameter overrides (model, temperature, systemPrompt)
 * 3. Calls beforeLLM() before every provider.complete()
 * 4. Calls afterLLM() after every provider.complete()
 * 5. Exposes the ProviderRegistry for agents_discover enrichment
 *
 * The agent uses the AIProvider directly via provider.complete() —
 * giving you full control over the message array, parameters, and
 * the entire request/response lifecycle.
 */
function createCompanionAgent(
  config: CompanionConfig,
  provider: AIProvider,
): AgentHandler {
  const sessions = new Map<string, SessionState>();
  const registry = new ProviderRegistry();
  registry.register(provider);

  const agent: AgentHandler & {
    setPromptRuntimeParams(sessionId: string, params: RuntimeParams): void;
    getProviderRegistry(): ProviderRegistry;
  } = {
    id: config.name,
    capabilities: config.capabilities,

    // ── Session lifecycle ──────────────────────────────────────

    async onSessionCreate(sessionId: string, metadata?: Record<string, unknown>): Promise<void> {
      // Extract session-level runtimeParams from metadata
      const sessionParams: RuntimeParams = (
        metadata?.runtimeParams !== undefined &&
        metadata.runtimeParams !== null &&
        typeof metadata.runtimeParams === 'object'
      )
        ? metadata.runtimeParams as RuntimeParams
        : {};

      sessions.set(sessionId, {
        messages: [],
        sessionParams,
        pendingPromptParams: undefined,
      });
    },

    async onSessionClose(sessionId: string): Promise<void> {
      sessions.delete(sessionId);
    },

    // ── Prompt pipeline ───────────────────────────────────────

    async prompt(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult> {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session "${sessionId}" does not exist`);
      }

      // 1. Extract and clear pending prompt-level params
      const promptParams = session.pendingPromptParams ?? {};
      session.pendingPromptParams = undefined;

      // 2. Merge params: config defaults < session params < prompt params
      const mergedParams = mergeRuntimeParams(config.defaults, session.sessionParams, promptParams);

      // ═══════════════════════════════════════════════════════════
      // 3. BEFORE LLM — your custom pre-processing logic
      //
      //    This is where you call MCP tools, do RAG retrieval,
      //    validate input, enrich context, etc.
      // ═══════════════════════════════════════════════════════════
      const enrichedInput = await beforeLLM(input, session);

      // 4. Build messages array: system prompt + history + current input
      const systemPrompt = mergedParams.systemPrompt ?? config.systemPrompt;
      const messages: ChatMessage[] = [];

      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push(...session.messages);
      messages.push({ role: 'user', content: enrichedInput });

      // 5. Call OpenAI via the provider
      const result = await provider.complete(messages, mergedParams, opts?.signal);

      // ═══════════════════════════════════════════════════════════
      // 6. AFTER LLM — your custom post-processing logic
      //
      //    This is where you parse tool calls, save to memory,
      //    execute actions, format output, etc.
      // ═══════════════════════════════════════════════════════════
      const finalText = await afterLLM(result.text, input, session);

      // 7. Update conversation history
      session.messages.push({ role: 'user', content: enrichedInput });
      session.messages.push({ role: 'assistant', content: finalText });

      // 8. Return result to MCP client
      const agentResult: AgentResult = {
        text: finalText,
        stopReason: result.stopReason,
      };
      if (result.usage !== undefined) {
        agentResult.usage = result.usage;
      }
      return agentResult;
    },

    // ── McpAgenticServer integration (duck-typing) ────────────

    /**
     * Set prompt-level RuntimeParams for the next prompt() call.
     * Called by McpAgenticServer when sessions_prompt or tasks_delegate
     * includes runtimeParams. Consumed and cleared after the next prompt().
     */
    setPromptRuntimeParams(sessionId: string, params: RuntimeParams): void {
      const session = sessions.get(sessionId);
      if (session) {
        session.pendingPromptParams = params;
      }
    },

    /**
     * Expose the ProviderRegistry for agents_discover enrichment.
     * McpAgenticServer reads this via duck-typing to include provider
     * info (id, models, kind, capabilities) in discovery responses.
     */
    getProviderRegistry(): ProviderRegistry {
      return registry;
    },
  };

  return agent;
}

// ── Start Server ────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  // Create OpenAI provider via the declarative factory API.
  // Zod validates options at call time; the openai SDK is loaded lazily.
  const provider = openAI({
    apiKey: config.apiKey,
    models: [config.model],
    defaults: { model: config.model },
  });

  // Create the companion agent with full prompt pipeline control.
  // The agent implements AgentHandler directly — beforeLLM() and afterLLM()
  // hooks run on every prompt, wrapping the provider.complete() call.
  const agent = createCompanionAgent(config, provider);

  // Pass the agent directly via the config — no separate .register() needed.
  const server = new McpAgenticServer({
    agents: [agent],
    defaultAgentId: config.name,
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
