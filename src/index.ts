/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Agentic — Public API
 *
 * This is the single entry point for consumers of the @stdiobus/mcp-agentic package.
 * Import everything you need from here.
 *
 * @example
 * import { McpAgenticServer } from '@stdiobus/mcp-agentic';
 * import type { AgentHandler, AgentResult } from '@stdiobus/mcp-agentic';
 *
 * const agent: AgentHandler = {
 *   id: 'my-agent',
 *   async prompt(sessionId, input) {
 *     return { text: 'Hello!', stopReason: 'end_turn' };
 *   },
 * };
 *
 * const server = new McpAgenticServer().register(agent);
 * await server.startStdio();
 */

// ─── Server ──────────────────────────────────────────────────────

export { McpAgenticServer } from './server/McpAgenticServer.js';
export type { McpAgenticServerConfig } from './server/McpAgenticServer.js';

// ─── Agent contract ──────────────────────────────────────────────

export type {
  Agent,
  AgentHandler,
  AgentResult,
  AgentEvent,
  AgentChunk,
  AgentFinal,
  AgentError,
  PromptOpts,
  StreamOpts,
} from './agent/AgentHandler.js';

// ─── Worker configuration ────────────────────────────────────────

export type { WorkerConfig } from './executor/types.js';

// ─── Provider Layer ──────────────────────────────────────────────

export type {
  AIProvider,
  AIProviderResult,
  RuntimeParams,
  ProviderConfig,
  ChatMessage,
} from './provider/index.js';

export { mergeRuntimeParams, ProviderRegistry } from './provider/index.js';
export type { ProviderInfo } from './provider/index.js';

export { OpenAIProvider, getMaxTokensParamName } from './provider/index.js';
export { AnthropicProvider } from './provider/index.js';
export { GoogleGeminiProvider } from './provider/index.js';

// ─── Multi-Provider Agent ────────────────────────────────────────

export { MultiProviderCompanionAgent } from './agent/MultiProviderCompanionAgent.js';
export type { MultiProviderCompanionConfig } from './agent/MultiProviderCompanionAgent.js';
