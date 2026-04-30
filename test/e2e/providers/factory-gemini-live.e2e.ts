/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: Google Gemini Factory API — Real API calls through full MCP Agentic pipeline.
 *
 * Uses the new Factory API (`gemini()` + `createMultiProviderAgent()`) instead of
 * the class-based API (`GoogleGeminiProvider.create()` + manual `ProviderRegistry` wiring).
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → MultiProviderAgent → Gemini SDK → Gemini API
 *
 * Requires: GOOGLE_AI_API_KEY environment variable.
 * Skipped automatically when the key is not set.
 */

import {
  skipIfNoKey,
  createTestServer,
  parseToolResult,
  check,
  reportAndExit,
  assertValidResponse,
  assertValidUsage,
  assertEndTurn,
} from './_helpers.js';
import { gemini } from '../../../src/provider/factories/gemini.js';
import { createMultiProviderAgent } from '../../../src/provider/factories/createMultiProviderAgent.js';

// ── Skip if no API key ──────────────────────────────────────────

skipIfNoKey('GOOGLE_AI_API_KEY');

// ── Setup ───────────────────────────────────────────────────────

function setup() {
  const provider = gemini({
    apiKey: process.env['GOOGLE_AI_API_KEY']!,
    models: ['gemini-2.0-flash'],
    defaults: { model: 'gemini-2.0-flash' },
  });

  const agent = createMultiProviderAgent({
    id: 'factory-gemini-agent',
    providers: [provider],
    defaultProviderId: 'google-gemini',
    capabilities: ['chat', 'gemini'],
    systemPrompt: 'You are a helpful assistant. Keep responses brief.',
  });

  return createTestServer(agent);
}

// ── Tests ───────────────────────────────────────────────────────

async function testBasicPrompt() {
  console.log('\n  [1] Basic session + prompt via factory API — real Gemini response');

  const { client, close } = await setup();

  try {
    // Create session
    const createResult = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'factory-gemini-agent' },
    });
    const { sessionId } = parseToolResult(createResult);
    check(typeof sessionId === 'string' && sessionId.length > 0, 'session created');

    // Send prompt
    const promptResult = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId, prompt: 'What is 2 + 2? Reply with just the number.' },
    });
    const response = parseToolResult(promptResult);

    assertValidResponse(response, 'basic prompt');
    assertEndTurn(response, 'basic prompt');
    assertValidUsage(response, 'basic prompt');

    // Close session
    await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
  } finally {
    await close();
  }
}

async function testAgentsDiscoverEnrichedInfo() {
  console.log('\n  [2] agents_discover — enriched provider info (kind, capabilities, displayName)');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'agents_discover',
      arguments: {},
    });
    const { agents } = parseToolResult(result);

    check(agents.length >= 1, `at least 1 agent discovered (got ${agents.length})`);

    const agent = agents.find((a: any) => a.id === 'factory-gemini-agent');
    check(agent !== undefined, 'factory-gemini-agent found in discovery');

    if (agent) {
      check(Array.isArray(agent.providers), 'providers field is an array');
      check(agent.providers.length === 1, `exactly 1 provider (got ${agent.providers?.length})`);

      const providerInfo = agent.providers?.[0];
      if (providerInfo) {
        check(providerInfo.id === 'google-gemini', `provider id is "google-gemini" (got "${providerInfo.id}")`);
        check(
          Array.isArray(providerInfo.models) && providerInfo.models.includes('gemini-2.0-flash'),
          'provider models include gemini-2.0-flash',
        );
        check(
          providerInfo.kind === 'llm',
          `provider kind is "llm" (got "${providerInfo.kind}")`,
        );
        check(
          providerInfo.capabilities?.streaming === false,
          `capabilities.streaming is false (got ${providerInfo.capabilities?.streaming})`,
        );
        check(
          providerInfo.capabilities?.tools === false,
          `capabilities.tools is false (got ${providerInfo.capabilities?.tools})`,
        );
        check(
          providerInfo.capabilities?.vision === true,
          `capabilities.vision is true (got ${providerInfo.capabilities?.vision})`,
        );
        check(
          providerInfo.capabilities?.jsonMode === true,
          `capabilities.jsonMode is true (got ${providerInfo.capabilities?.jsonMode})`,
        );
        check(
          providerInfo.displayName === 'Google Gemini',
          `displayName is "Google Gemini" (got "${providerInfo.displayName}")`,
        );
      }
    }
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: Google Gemini Factory API — Live API tests\n');

  await testBasicPrompt();
  await testAgentsDiscoverEnrichedInfo();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
