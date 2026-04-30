/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for live provider E2E tests.
 *
 * These tests exercise real AI provider APIs (OpenAI, Anthropic, Google Gemini)
 * through the full MCP Agentic pipeline:
 *   MCP Client → InMemoryTransport → McpAgenticServer → MultiProviderCompanionAgent → Provider SDK → API
 *
 * Tests are skipped when the corresponding API key environment variable is not set.
 * They are NOT run in CI by default — only locally with valid API keys.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentHandler } from '../../../src/agent/AgentHandler.js';
import { McpAgenticServer } from '../../../src/server/McpAgenticServer.js';

// ── Skip helper ─────────────────────────────────────────────────

/**
 * Skip the current test file if the specified environment variable is not set.
 * Prints a skip message and exits with code 0 (success).
 *
 * @param envVar - Environment variable name to check (e.g., 'OPENAI_API_KEY').
 */
export function skipIfNoKey(envVar: string): void {
  if (!process.env[envVar]) {
    console.log(`  ⏭ Skipping: ${envVar} not set in environment`);
    process.exit(0);
  }
}

/**
 * Check if at least one of the specified environment variables is set.
 * If none are set, skip the test file.
 *
 * @param envVars - Array of environment variable names to check.
 */
export function skipIfNoKeys(envVars: string[]): void {
  const hasAny = envVars.some((v) => !!process.env[v]);
  if (!hasAny) {
    console.log(`  ⏭ Skipping: none of [${envVars.join(', ')}] set in environment`);
    process.exit(0);
  }
}

// ── Server setup helper ─────────────────────────────────────────

/**
 * Result of createTestServer — provides MCP client and cleanup function.
 */
export interface TestServerContext {
  /** MCP client connected to the server via InMemoryTransport. */
  client: Client;
  /** Gracefully shut down the server and client. */
  close: () => Promise<void>;
}

/**
 * Create a McpAgenticServer with the given agent, connect via InMemoryTransport,
 * and return an MCP client ready to call tools.
 *
 * Uses the real McpAgenticServer (not a manual wire-up) so that all tool handlers,
 * runtimeParams injection, and backpressure logic are exercised.
 *
 * @param agent - AgentHandler to register in the server.
 * @returns TestServerContext with client and close function.
 */
export async function createTestServer(agent: AgentHandler): Promise<TestServerContext> {
  const server = new McpAgenticServer({ silent: true, agents: [agent] });

  // Create linked InMemoryTransport pair
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Connect server to its transport (bypasses stdio)
  // Access the internal mcpServer to connect via InMemoryTransport
  const mcpServer = (server as any).mcpServer;

  // Start the in-process executor
  await (server as any).inProcess.start();
  await (server as any).populateAgentExecutorCache();

  await mcpServer.connect(serverTransport);

  // Create and connect client
  const client = new Client({ name: 'live-e2e-client', version: '1.0.0' });
  await client.connect(clientTransport);

  const close = async () => {
    await client.close();
    await server.close();
  };

  return { client, close };
}

// ── Result parsing ──────────────────────────────────────────────

/**
 * Parse the JSON text content from an MCP tool call result.
 *
 * @param result - Raw MCP tool call result.
 * @returns Parsed JSON object.
 * @throws If the result has no text content or is not valid JSON.
 */
export function parseToolResult(result: any): any {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error('Empty tool result');
  return JSON.parse(text);
}

// ── Assertion helpers ───────────────────────────────────────────

/** Counters for pass/fail tracking. */
let passed = 0;
let failed = 0;

/**
 * Assert a condition and log the result.
 *
 * @param condition - Boolean condition to check.
 * @param message - Description of what is being checked.
 */
export function check(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log('  ✓', message);
  } else {
    failed++;
    console.error('  ✗', message);
  }
}

/**
 * Get the current pass/fail counts and exit with appropriate code.
 * Call this at the end of each test file.
 */
export function reportAndExit(): void {
  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

/**
 * Reset counters (useful if running multiple test groups in one file).
 */
export function resetCounters(): void {
  passed = 0;
  failed = 0;
}

// ── Common response assertions ──────────────────────────────────

/**
 * Assert that a provider response has valid structure:
 * - text is a non-empty string
 * - stopReason is a valid normalized value
 * - usage (if present) has positive inputTokens and outputTokens
 *
 * @param response - Parsed response from sessions_prompt or tasks_delegate.
 * @param label - Test label for logging.
 */
export function assertValidResponse(response: any, label: string): void {
  check(
    typeof response.text === 'string' && response.text.length > 0,
    `${label}: text is non-empty string (got ${response.text?.length ?? 0} chars)`,
  );
  check(
    typeof response.stopReason === 'string' && response.stopReason.length > 0,
    `${label}: stopReason is non-empty (got "${response.stopReason}")`,
  );
}

/**
 * Assert that a response has valid usage data.
 *
 * @param response - Parsed response from sessions_prompt or tasks_delegate.
 * @param label - Test label for logging.
 */
export function assertValidUsage(response: any, label: string): void {
  check(
    response.usage !== undefined,
    `${label}: usage is present`,
  );
  if (response.usage) {
    check(
      typeof response.usage.inputTokens === 'number' && response.usage.inputTokens > 0,
      `${label}: inputTokens > 0 (got ${response.usage.inputTokens})`,
    );
    check(
      typeof response.usage.outputTokens === 'number' && response.usage.outputTokens > 0,
      `${label}: outputTokens > 0 (got ${response.usage.outputTokens})`,
    );
  }
}

/**
 * Assert that a response indicates end_turn stop reason.
 *
 * @param response - Parsed response.
 * @param label - Test label for logging.
 */
export function assertEndTurn(response: any, label: string): void {
  check(
    response.stopReason === 'end_turn',
    `${label}: stopReason === 'end_turn' (got "${response.stopReason}")`,
  );
}
