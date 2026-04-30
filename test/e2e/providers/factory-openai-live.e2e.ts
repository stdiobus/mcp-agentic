/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: OpenAI Factory API — Real API calls through full MCP Agentic pipeline.
 *
 * Uses the new Factory API (`openAI()` + `createMultiProviderAgent()`) instead of
 * the class-based API (`OpenAIProvider.create()` + manual `ProviderRegistry` wiring).
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → MultiProviderAgent → OpenAI SDK → OpenAI API
 *
 * Requires: OPENAI_API_KEY environment variable.
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
import { openAI } from '../../../src/provider/factories/openai.js';
import { createMultiProviderAgent } from '../../../src/provider/factories/createMultiProviderAgent.js';

// ── Skip if no API key ──────────────────────────────────────────

skipIfNoKey('OPENAI_API_KEY');

// ── Setup ───────────────────────────────────────────────────────

function setup() {
  const provider = openAI({
    apiKey: process.env['OPENAI_API_KEY']!,
    models: ['gpt-4o-mini'],
    defaults: { model: 'gpt-4o-mini' },
  });

  const agent = createMultiProviderAgent({
    id: 'factory-openai-agent',
    providers: [provider],
    defaultProviderId: 'openai',
    capabilities: ['chat', 'openai'],
    systemPrompt: 'You are a helpful assistant. Keep responses brief.',
  });

  return createTestServer(agent);
}

// ── Tests ───────────────────────────────────────────────────────

async function testBasicPrompt() {
  console.log('\n  [1] Basic session + prompt via factory API — real OpenAI response');

  const { client, close } = await setup();

  try {
    // Create session
    const createResult = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'factory-openai-agent' },
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

async function testTasksDelegateWithRuntimeParams() {
  console.log('\n  [2] tasks_delegate with runtimeParams via factory API');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'tasks_delegate',
      arguments: {
        prompt: 'Say hello in one word.',
        agentId: 'factory-openai-agent',
        runtimeParams: { temperature: 0, maxTokens: 50 },
      },
    });
    const response = parseToolResult(result);

    check(response.success === true, 'delegation succeeded');
    assertValidResponse(response, 'tasks_delegate');
    check(
      response.text.length < 500,
      `response is short with maxTokens=50 (got ${response.text.length} chars)`,
    );
  } finally {
    await close();
  }
}

async function testAgentsDiscoverEnrichedInfo() {
  console.log('\n  [3] agents_discover — enriched provider info (kind, capabilities, displayName)');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'agents_discover',
      arguments: {},
    });
    const { agents } = parseToolResult(result);

    check(agents.length >= 1, `at least 1 agent discovered (got ${agents.length})`);

    const agent = agents.find((a: any) => a.id === 'factory-openai-agent');
    check(agent !== undefined, 'factory-openai-agent found in discovery');

    if (agent) {
      check(Array.isArray(agent.providers), 'providers field is an array');
      check(agent.providers.length === 1, `exactly 1 provider (got ${agent.providers?.length})`);

      const providerInfo = agent.providers?.[0];
      if (providerInfo) {
        check(providerInfo.id === 'openai', `provider id is "openai" (got "${providerInfo.id}")`);
        check(
          Array.isArray(providerInfo.models) && providerInfo.models.includes('gpt-4o-mini'),
          'provider models include gpt-4o-mini',
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
          providerInfo.capabilities?.jsonMode === true,
          `capabilities.jsonMode is true (got ${providerInfo.capabilities?.jsonMode})`,
        );
        check(
          providerInfo.displayName === 'OpenAI',
          `displayName is "OpenAI" (got "${providerInfo.displayName}")`,
        );
      }
    }
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: OpenAI Factory API — Live API tests\n');

  await testBasicPrompt();
  await testTasksDelegateWithRuntimeParams();
  await testAgentsDiscoverEnrichedInfo();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
