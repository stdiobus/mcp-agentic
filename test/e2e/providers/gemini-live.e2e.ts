/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: Google Gemini Provider — Real API calls through full MCP Agentic pipeline.
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → MultiProviderCompanionAgent → Gemini SDK → Gemini API
 *
 * Requires: GOOGLE_AI_API_KEY environment variable.
 * Skipped automatically when the key is not set.
 *
 * Timeout: 30s per test.
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
import { GoogleGeminiProvider } from '../../../src/provider/providers/GoogleGeminiProvider.js';
import { ProviderRegistry } from '../../../src/provider/ProviderRegistry.js';
import { MultiProviderCompanionAgent } from '../../../src/agent/MultiProviderCompanionAgent.js';

// ── Skip if no API key ──────────────────────────────────────────

skipIfNoKey('GOOGLE_AI_API_KEY');

// ── Setup ───────────────────────────────────────────────────────

async function setup() {
  const provider = await GoogleGeminiProvider.create({
    credentials: { apiKey: process.env['GOOGLE_AI_API_KEY']! },
    models: ['gemini-2.0-flash'],
    defaults: { model: 'gemini-2.0-flash' },
  });

  const registry = new ProviderRegistry();
  registry.register(provider);

  const agent = new MultiProviderCompanionAgent({
    id: 'gemini-agent',
    defaultProviderId: 'google-gemini',
    registry,
    capabilities: ['chat', 'gemini'],
    systemPrompt: 'You are a helpful assistant. Keep responses brief.',
  });

  return createTestServer(agent);
}

// ── Tests ───────────────────────────────────────────────────────

async function testBasicPrompt() {
  console.log('\n  [1] Basic session + prompt — real Gemini response');

  const { client, close } = await setup();

  try {
    // Create session
    const createResult = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'gemini-agent' },
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
  console.log('\n  [2] tasks_delegate with runtimeParams — constrained response');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'tasks_delegate',
      arguments: {
        prompt: 'Say hello in one word.',
        agentId: 'gemini-agent',
        runtimeParams: { temperature: 0, maxTokens: 50 },
      },
    });
    const response = parseToolResult(result);

    check(response.success === true, 'delegation succeeded');
    assertValidResponse(response, 'tasks_delegate');
    // With maxTokens: 50, the response should be short
    if (typeof response.text === 'string') {
      check(
        response.text.length < 500,
        `response is short with maxTokens=50 (got ${response.text.length} chars)`,
      );
    }
  } finally {
    await close();
  }
}

async function testMultiTurnConversation() {
  console.log('\n  [3] Multi-turn conversation — Gemini content format works correctly');

  const { client, close } = await setup();

  try {
    const { sessionId } = parseToolResult(
      await client.callTool({
        name: 'sessions_create',
        arguments: { agentId: 'gemini-agent' },
      }),
    );

    // Turn 1: introduce a fact
    const r1 = parseToolResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: {
          sessionId,
          prompt: 'Remember this number: 42. Just acknowledge.',
        },
      }),
    );
    assertValidResponse(r1, 'turn 1');

    // Turn 2: ask about the fact
    const r2 = parseToolResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: {
          sessionId,
          prompt: 'What number did I ask you to remember? Reply with just the number.',
        },
      }),
    );
    assertValidResponse(r2, 'turn 2');
    check(
      r2.text.includes('42'),
      `context preserved — response contains "42" (got "${r2.text.substring(0, 100)}")`,
    );

    // Turn 3: verify continued context
    const r3 = parseToolResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: {
          sessionId,
          prompt: 'Add 8 to that number. Reply with just the result.',
        },
      }),
    );
    assertValidResponse(r3, 'turn 3');
    check(
      r3.text.includes('50'),
      `multi-turn math — response contains "50" (got "${r3.text.substring(0, 100)}")`,
    );

    await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: Google Gemini Provider — Live API tests\n');

  await testBasicPrompt();
  await testTasksDelegateWithRuntimeParams();
  await testMultiTurnConversation();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
