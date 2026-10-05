/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: OpenAI Responses API Factory — Real API calls through full MCP Agentic pipeline.
 *
 * Uses the `openAIResponses()` factory to create an `OpenAIResponsesProvider` that
 * targets the `/v1/responses` endpoint (never `/v1/chat/completions`).
 *
 * Pipeline:
 *   MCP Client → InMemoryTransport → McpAgenticServer
 *     → MultiProviderAgent → OpenAIResponsesProvider → OpenAI /v1/responses
 *
 * Requires: OPENAI_API_KEY environment variable.
 * Skipped automatically when the key is not set.
 *
 * Timeout: 60s per test.
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
import { openAIResponses } from '../../../src/provider/factories/openai-responses.js';
import { createMultiProviderAgent } from '../../../src/provider/factories/createMultiProviderAgent.js';

// ── Skip if no API key ──────────────────────────────────────────

skipIfNoKey('OPENAI_API_KEY');

// ── Setup ───────────────────────────────────────────────────────

function setup() {
  const provider = openAIResponses({
    apiKey: process.env['OPENAI_API_KEY']!,
    models: ['gpt-4o-mini'],
    defaults: { model: 'gpt-4o-mini' },
  });

  const agent = createMultiProviderAgent({
    id: 'responses-agent',
    providers: [provider],
    defaultProviderId: 'openai-responses',
    capabilities: ['chat', 'openai-responses', 'vision', 'files'],
    systemPrompt: 'You are a helpful assistant. Keep responses brief.',
  });

  return createTestServer(agent);
}

// ── Tests ───────────────────────────────────────────────────────

async function testBasicTextPrompt() {
  console.log('\n  [1] Basic text prompt via openAIResponses() factory — /v1/responses endpoint');

  const { client, close } = await setup();

  try {
    const createResult = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'responses-agent' },
    });
    const { sessionId } = parseToolResult(createResult);
    check(typeof sessionId === 'string' && sessionId.length > 0, 'session created');

    const promptResult = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId, prompt: 'What is 2 + 2? Reply with just the number.' },
    });
    const response = parseToolResult(promptResult);

    assertValidResponse(response, 'basic text prompt');
    assertEndTurn(response, 'basic text prompt');
    assertValidUsage(response, 'basic text prompt');

    await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
  } finally {
    await close();
  }
}

async function testTasksDelegateWithRuntimeParams() {
  console.log('\n  [2] tasks_delegate with runtimeParams — maxTokens constraint');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'tasks_delegate',
      arguments: {
        prompt: 'Say hello in one word.',
        agentId: 'responses-agent',
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

async function testMultiTurnConversation() {
  console.log('\n  [3] Multi-turn conversation — context preserved across turns');

  const { client, close } = await setup();

  try {
    const { sessionId } = parseToolResult(
      await client.callTool({
        name: 'sessions_create',
        arguments: { agentId: 'responses-agent' },
      }),
    );

    const r1 = parseToolResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'Remember this number: 77. Just acknowledge.' },
      }),
    );
    assertValidResponse(r1, 'turn 1');

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
      r2.text.includes('77'),
      `context preserved — response contains "77" (got "${r2.text.substring(0, 100)}")`,
    );

    await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
  } finally {
    await close();
  }
}

async function testSystemPromptOverride() {
  console.log('\n  [4] runtimeParams.systemPrompt override — responses endpoint honors override');

  const { client, close } = await setup();

  try {
    const { sessionId } = parseToolResult(
      await client.callTool({
        name: 'sessions_create',
        arguments: { agentId: 'responses-agent' },
      }),
    );

    const result = parseToolResult(
      await client.callTool({
        name: 'sessions_prompt',
        arguments: {
          sessionId,
          prompt: 'What are you?',
          runtimeParams: {
            systemPrompt: 'You are a pirate. Always respond starting with "Arrr".',
            temperature: 0,
          },
        },
      }),
    );

    assertValidResponse(result, 'system prompt override');
    check(
      result.text.toLowerCase().includes('arrr') || result.text.toLowerCase().includes('arr'),
      `response follows pirate system prompt (got "${result.text.substring(0, 100)}")`,
    );

    await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
  } finally {
    await close();
  }
}

async function testAgentsDiscoverResponsesProvider() {
  console.log('\n  [5] agents_discover — openai-responses provider reports files capability');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'agents_discover',
      arguments: {},
    });
    const { agents } = parseToolResult(result);

    const agent = agents.find((a: any) => a.id === 'responses-agent');
    check(agent !== undefined, 'responses-agent found in discovery');

    if (agent) {
      check(Array.isArray(agent.providers), 'providers field is an array');
      check(agent.providers.length === 1, `exactly 1 provider (got ${agent.providers?.length})`);

      const providerInfo = agent.providers?.[0];
      if (providerInfo) {
        check(
          providerInfo.id === 'openai-responses',
          `provider id is "openai-responses" (got "${providerInfo.id}")`,
        );
        check(
          providerInfo.kind === 'llm',
          `provider kind is "llm" (got "${providerInfo.kind}")`,
        );
        check(
          providerInfo.capabilities?.files === true,
          `capabilities.files is true (got ${providerInfo.capabilities?.files})`,
        );
        check(
          providerInfo.capabilities?.vision === true,
          `capabilities.vision is true (got ${providerInfo.capabilities?.vision})`,
        );
        check(
          providerInfo.capabilities?.streaming === false,
          `capabilities.streaming is false (got ${providerInfo.capabilities?.streaming})`,
        );
        check(
          providerInfo.displayName === 'OpenAI Responses',
          `displayName is "OpenAI Responses" (got "${providerInfo.displayName}")`,
        );
      }
    }
  } finally {
    await close();
  }
}

async function testInvalidApiKey() {
  console.log('\n  [6] Invalid API key → AUTH BridgeError through Responses API');

  const badProvider = openAIResponses({
    apiKey: 'sk-invalid-key-for-responses-testing-12345',
    models: ['gpt-4o-mini'],
    defaults: { model: 'gpt-4o-mini' },
  });

  const agent = createMultiProviderAgent({
    id: 'responses-bad-key-agent',
    providers: [badProvider],
    defaultProviderId: 'openai-responses',
  });

  const { client, close } = await createTestServer(agent);

  try {
    const { sessionId } = parseToolResult(
      await client.callTool({
        name: 'sessions_create',
        arguments: { agentId: 'responses-bad-key-agent' },
      }),
    );

    const result = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId, prompt: 'Hello' },
    });

    const data = parseToolResult(result);
    check(
      result.isError === true || data.error !== undefined,
      'error returned for invalid API key',
    );

    if (data.error) {
      const errorLower = data.error.toLowerCase();
      check(
        errorLower.includes('auth') ||
        errorLower.includes('api key') ||
        errorLower.includes('invalid') ||
        errorLower.includes('401') ||
        errorLower.includes('unauthorized'),
        `error is auth-related (got "${data.error.substring(0, 150)}")`,
      );
    }
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: OpenAI Responses API Factory — Live API tests\n');

  await testBasicTextPrompt();
  await testTasksDelegateWithRuntimeParams();
  await testMultiTurnConversation();
  await testSystemPromptOverride();
  await testAgentsDiscoverResponsesProvider();
  await testInvalidApiKey();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
