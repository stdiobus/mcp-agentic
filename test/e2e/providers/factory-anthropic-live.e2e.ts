/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: Anthropic Factory API — Real API calls through full MCP Agentic pipeline.
 *
 * Uses the new Factory API (`anthropic()` + `createMultiProviderAgent()`) instead of
 * the class-based API (`AnthropicProvider.create()` + manual `ProviderRegistry` wiring).
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → MultiProviderCompanionAgent → Anthropic SDK → Anthropic API
 *
 * Requires: ANTHROPIC_API_KEY environment variable.
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
import { anthropic } from '../../../src/provider/factories/anthropic.js';
import { createMultiProviderAgent } from '../../../src/provider/factories/createMultiProviderAgent.js';

// ── Skip if no API key ──────────────────────────────────────────

skipIfNoKey('ANTHROPIC_API_KEY');

// ── Setup ───────────────────────────────────────────────────────

function setup() {
  const provider = anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY']!,
    models: ['claude-sonnet-4-20250514'],
    defaults: { model: 'claude-sonnet-4-20250514', maxTokens: 1024 },
  });

  const agent = createMultiProviderAgent({
    id: 'factory-anthropic-agent',
    providers: [provider],
    defaultProviderId: 'anthropic',
    capabilities: ['chat', 'anthropic'],
    systemPrompt: 'You are a helpful assistant. Keep responses brief.',
  });

  return createTestServer(agent);
}

// ── Tests ───────────────────────────────────────────────────────

async function testBasicPrompt() {
  console.log('\n  [1] Basic session + prompt via factory API — real Anthropic response');

  const { client, close } = await setup();

  try {
    // Create session
    const createResult = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'factory-anthropic-agent' },
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

    const agent = agents.find((a: any) => a.id === 'factory-anthropic-agent');
    check(agent !== undefined, 'factory-anthropic-agent found in discovery');

    if (agent) {
      check(Array.isArray(agent.providers), 'providers field is an array');
      check(agent.providers.length === 1, `exactly 1 provider (got ${agent.providers?.length})`);

      const providerInfo = agent.providers?.[0];
      if (providerInfo) {
        check(providerInfo.id === 'anthropic', `provider id is "anthropic" (got "${providerInfo.id}")`);
        check(
          Array.isArray(providerInfo.models) && providerInfo.models.includes('claude-sonnet-4-20250514'),
          'provider models include claude-sonnet-4-20250514',
        );
        check(
          providerInfo.kind === 'llm',
          `provider kind is "llm" (got "${providerInfo.kind}")`,
        );
        check(
          providerInfo.capabilities?.streaming === true,
          `capabilities.streaming is true (got ${providerInfo.capabilities?.streaming})`,
        );
        check(
          providerInfo.capabilities?.tools === true,
          `capabilities.tools is true (got ${providerInfo.capabilities?.tools})`,
        );
        check(
          providerInfo.capabilities?.vision === true,
          `capabilities.vision is true (got ${providerInfo.capabilities?.vision})`,
        );
        check(
          providerInfo.capabilities?.jsonMode === false,
          `capabilities.jsonMode is false (got ${providerInfo.capabilities?.jsonMode})`,
        );
        check(
          providerInfo.displayName === 'Anthropic',
          `displayName is "Anthropic" (got "${providerInfo.displayName}")`,
        );
      }
    }
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: Anthropic Factory API — Live API tests\n');

  await testBasicPrompt();
  await testAgentsDiscoverEnrichedInfo();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
