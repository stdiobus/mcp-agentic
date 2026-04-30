/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: Multi-provider switching — Multiple providers in one server.
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → MultiProviderCompanionAgent → [OpenAI | Anthropic | Gemini]
 *
 * Requires: At least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY.
 * Skipped automatically when none are set.
 *
 * Timeout: 60s for the entire file.
 */

import {
  skipIfNoKeys,
  createTestServer,
  parseToolResult,
  check,
  reportAndExit,
  assertValidResponse,
} from './_helpers.js';
import { OpenAIProvider } from '../../../src/provider/providers/OpenAIProvider.js';
import { AnthropicProvider } from '../../../src/provider/providers/AnthropicProvider.js';
import { GoogleGeminiProvider } from '../../../src/provider/providers/GoogleGeminiProvider.js';
import { ProviderRegistry } from '../../../src/provider/ProviderRegistry.js';
import { MultiProviderCompanionAgent } from '../../../src/agent/MultiProviderCompanionAgent.js';
import type { TestServerContext } from './_helpers.js';

// ── Skip if no API keys ─────────────────────────────────────────

const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_AI_API_KEY'] as const;
skipIfNoKeys([...KEYS]);

// ── Detect available providers ──────────────────────────────────

const hasOpenAI = !!process.env['OPENAI_API_KEY'];
const hasAnthropic = !!process.env['ANTHROPIC_API_KEY'];
const hasGemini = !!process.env['GOOGLE_AI_API_KEY'];

// ── Setup ───────────────────────────────────────────────────────

async function setup(): Promise<TestServerContext & { availableProviders: string[] }> {
  const registry = new ProviderRegistry();
  const availableProviders: string[] = [];

  // Determine default provider (first available)
  let defaultProviderId = '';

  if (hasOpenAI) {
    const provider = await OpenAIProvider.create({
      credentials: { apiKey: process.env['OPENAI_API_KEY']! },
      models: ['gpt-4o-mini'],
      defaults: { model: 'gpt-4o-mini' },
    });
    registry.register(provider);
    availableProviders.push('openai');
    if (!defaultProviderId) defaultProviderId = 'openai';
  }

  if (hasAnthropic) {
    const provider = await AnthropicProvider.create({
      credentials: { apiKey: process.env['ANTHROPIC_API_KEY']! },
      models: ['claude-sonnet-4-20250514'],
      defaults: { model: 'claude-sonnet-4-20250514', maxTokens: 1024 },
    });
    registry.register(provider);
    availableProviders.push('anthropic');
    if (!defaultProviderId) defaultProviderId = 'anthropic';
  }

  if (hasGemini) {
    const provider = await GoogleGeminiProvider.create({
      credentials: { apiKey: process.env['GOOGLE_AI_API_KEY']! },
      models: ['gemini-2.0-flash'],
      defaults: { model: 'gemini-2.0-flash' },
    });
    registry.register(provider);
    availableProviders.push('google-gemini');
    if (!defaultProviderId) defaultProviderId = 'google-gemini';
  }

  const agent = new MultiProviderCompanionAgent({
    id: 'multi-provider-agent',
    defaultProviderId,
    registry,
    capabilities: ['chat', 'multi-provider'],
    systemPrompt: 'You are a helpful assistant. Keep responses brief.',
  });

  const ctx = await createTestServer(agent);
  return { ...ctx, availableProviders };
}

// ── Tests ───────────────────────────────────────────────────────

async function testProviderSwitching() {
  console.log('\n  [1-3] Provider switching via metadata.provider');

  const { client, close, availableProviders } = await setup();

  try {
    for (const providerId of availableProviders) {
      console.log(`\n    Testing provider: ${providerId}`);

      const createResult = await client.callTool({
        name: 'sessions_create',
        arguments: {
          agentId: 'multi-provider-agent',
          metadata: { provider: providerId },
        },
      });
      const { sessionId } = parseToolResult(createResult);
      check(typeof sessionId === 'string', `${providerId}: session created`);

      const promptResult = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'Say "hello" in one word.' },
      });
      const response = parseToolResult(promptResult);
      assertValidResponse(response, `${providerId}: prompt`);

      await client.callTool({ name: 'sessions_close', arguments: { sessionId } });
    }
  } finally {
    await close();
  }
}

async function testAgentsDiscoverIncludesProviders() {
  console.log('\n  [4] agents_discover — response contains providers');

  const { client, close, availableProviders } = await setup();

  try {
    const result = await client.callTool({
      name: 'agents_discover',
      arguments: {},
    });
    const { agents } = parseToolResult(result);

    check(agents.length >= 1, `at least 1 agent discovered (got ${agents.length})`);

    const multiAgent = agents.find((a: any) => a.id === 'multi-provider-agent');
    check(multiAgent !== undefined, 'multi-provider-agent found in discovery');

    if (multiAgent) {
      check(
        Array.isArray(multiAgent.providers),
        'providers field is an array',
      );
      check(
        multiAgent.providers.length === availableProviders.length,
        `providers count matches (expected ${availableProviders.length}, got ${multiAgent.providers?.length})`,
      );

      for (const providerId of availableProviders) {
        const providerInfo = multiAgent.providers.find((p: any) => p.id === providerId);
        check(
          providerInfo !== undefined,
          `provider "${providerId}" found in discovery`,
        );
        check(
          Array.isArray(providerInfo?.models) && providerInfo.models.length > 0,
          `provider "${providerId}" has models`,
        );
      }
    }
  } finally {
    await close();
  }
}

async function testNonexistentProviderError() {
  console.log('\n  [5] sessions_create with nonexistent provider → error');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'sessions_create',
      arguments: {
        agentId: 'multi-provider-agent',
        metadata: { provider: 'nonexistent-provider' },
      },
    });

    // The result should be an error
    const data = parseToolResult(result);
    check(
      result.isError === true || data.error !== undefined,
      'error returned for nonexistent provider',
    );
    if (data.error) {
      check(
        data.error.includes('nonexistent-provider') || data.error.includes('not registered'),
        `error mentions the provider (got "${data.error}")`,
      );
    }
  } finally {
    await close();
  }
}

async function testTasksDelegateWithProviderSwitch() {
  console.log('\n  [6] tasks_delegate with provider switching via metadata');

  const { client, close, availableProviders } = await setup();

  try {
    // Use the first available provider
    const providerId = availableProviders[0];

    const result = await client.callTool({
      name: 'tasks_delegate',
      arguments: {
        prompt: 'Say "hello" in one word.',
        agentId: 'multi-provider-agent',
        metadata: { provider: providerId },
        runtimeParams: { temperature: 0, maxTokens: 50 },
      },
    });
    const response = parseToolResult(result);

    check(response.success === true, `tasks_delegate with ${providerId} succeeded`);
    assertValidResponse(response, `tasks_delegate (${providerId})`);
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: Multi-Provider Switching — Live API tests\n');
  console.log(`  Available providers: ${[hasOpenAI && 'openai', hasAnthropic && 'anthropic', hasGemini && 'google-gemini'].filter(Boolean).join(', ')}`);

  await testProviderSwitching();
  await testAgentsDiscoverIncludesProviders();
  await testNonexistentProviderError();
  await testTasksDelegateWithProviderSwitch();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
