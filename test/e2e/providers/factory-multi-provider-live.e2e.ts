/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: Multi-provider Factory API — Multiple providers via factory functions.
 *
 * Uses the new Factory API (`openAI()`, `anthropic()`, `gemini()` + `createMultiProviderAgent()`)
 * instead of the class-based API with manual `ProviderRegistry` wiring.
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → MultiProviderCompanionAgent → [OpenAI | Anthropic | Gemini]
 *
 * Requires: At least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY.
 * Skipped automatically when none are set.
 */

import {
  skipIfNoKeys,
  createTestServer,
  parseToolResult,
  check,
  reportAndExit,
  assertValidResponse,
} from './_helpers.js';
import { openAI } from '../../../src/provider/factories/openai.js';
import { anthropic } from '../../../src/provider/factories/anthropic.js';
import { gemini } from '../../../src/provider/factories/gemini.js';
import { createMultiProviderAgent } from '../../../src/provider/factories/createMultiProviderAgent.js';
import type { AIProvider } from '../../../src/provider/AIProvider.js';
import type { TestServerContext } from './_helpers.js';

// ── Skip if no API keys ─────────────────────────────────────────

const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_AI_API_KEY'] as const;
skipIfNoKeys([...KEYS]);

// ── Detect available providers ──────────────────────────────────

const hasOpenAI = !!process.env['OPENAI_API_KEY'];
const hasAnthropic = !!process.env['ANTHROPIC_API_KEY'];
const hasGemini = !!process.env['GOOGLE_AI_API_KEY'];

// ── Expected capabilities per provider ──────────────────────────

const expectedCapabilities: Record<string, Record<string, boolean>> = {
  openai: { streaming: true, tools: true, vision: true, jsonMode: true },
  anthropic: { streaming: true, tools: true, vision: true, jsonMode: false },
  'google-gemini': { streaming: false, tools: false, vision: true, jsonMode: true },
};

const expectedDisplayNames: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  'google-gemini': 'Google Gemini',
};

// ── Setup ───────────────────────────────────────────────────────

function setup(): Promise<TestServerContext & { availableProviders: string[] }> {
  const providers: AIProvider[] = [];
  const availableProviders: string[] = [];
  let defaultProviderId = '';

  if (hasOpenAI) {
    providers.push(openAI({
      apiKey: process.env['OPENAI_API_KEY']!,
      models: ['gpt-4o-mini'],
      defaults: { model: 'gpt-4o-mini' },
    }));
    availableProviders.push('openai');
    if (!defaultProviderId) defaultProviderId = 'openai';
  }

  if (hasAnthropic) {
    providers.push(anthropic({
      apiKey: process.env['ANTHROPIC_API_KEY']!,
      models: ['claude-sonnet-4-20250514'],
      defaults: { model: 'claude-sonnet-4-20250514', maxTokens: 1024 },
    }));
    availableProviders.push('anthropic');
    if (!defaultProviderId) defaultProviderId = 'anthropic';
  }

  if (hasGemini) {
    providers.push(gemini({
      apiKey: process.env['GOOGLE_AI_API_KEY']!,
      models: ['gemini-2.0-flash'],
      defaults: { model: 'gemini-2.0-flash' },
    }));
    availableProviders.push('google-gemini');
    if (!defaultProviderId) defaultProviderId = 'google-gemini';
  }

  const agent = createMultiProviderAgent({
    id: 'factory-multi-agent',
    providers,
    defaultProviderId,
    capabilities: ['chat', 'multi-provider'],
    systemPrompt: 'You are a helpful assistant. Keep responses brief.',
  });

  return createTestServer(agent).then((ctx) => ({ ...ctx, availableProviders }));
}

// ── Tests ───────────────────────────────────────────────────────

async function testProviderSwitching() {
  console.log('\n  [1] Provider switching via metadata.provider — each available provider responds');

  const { client, close, availableProviders } = await setup();

  try {
    for (const providerId of availableProviders) {
      console.log(`\n    Testing provider: ${providerId}`);

      const createResult = await client.callTool({
        name: 'sessions_create',
        arguments: {
          agentId: 'factory-multi-agent',
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

async function testAgentsDiscoverEnrichedInfo() {
  console.log('\n  [2] agents_discover — enriched info for all factory-created providers');

  const { client, close, availableProviders } = await setup();

  try {
    const result = await client.callTool({
      name: 'agents_discover',
      arguments: {},
    });
    const { agents } = parseToolResult(result);

    check(agents.length >= 1, `at least 1 agent discovered (got ${agents.length})`);

    const agent = agents.find((a: any) => a.id === 'factory-multi-agent');
    check(agent !== undefined, 'factory-multi-agent found in discovery');

    if (agent) {
      check(Array.isArray(agent.providers), 'providers field is an array');
      check(
        agent.providers.length === availableProviders.length,
        `providers count matches (expected ${availableProviders.length}, got ${agent.providers?.length})`,
      );

      for (const providerId of availableProviders) {
        const providerInfo = agent.providers.find((p: any) => p.id === providerId);
        check(providerInfo !== undefined, `provider "${providerId}" found in discovery`);

        if (providerInfo) {
          check(
            Array.isArray(providerInfo.models) && providerInfo.models.length > 0,
            `${providerId}: has models`,
          );
          check(
            providerInfo.kind === 'llm',
            `${providerId}: kind is "llm" (got "${providerInfo.kind}")`,
          );
          check(
            providerInfo.displayName === expectedDisplayNames[providerId],
            `${providerId}: displayName is "${expectedDisplayNames[providerId]}" (got "${providerInfo.displayName}")`,
          );

          // Verify capabilities match expected values
          const expected = expectedCapabilities[providerId];
          if (expected && providerInfo.capabilities) {
            for (const [key, value] of Object.entries(expected)) {
              check(
                providerInfo.capabilities[key] === value,
                `${providerId}: capabilities.${key} is ${value} (got ${providerInfo.capabilities[key]})`,
              );
            }
          }

          // Verify description is present (non-empty string)
          check(
            typeof providerInfo.description === 'string' && providerInfo.description.length > 0,
            `${providerId}: description is non-empty`,
          );
        }
      }
    }
  } finally {
    await close();
  }
}

async function testTasksDelegateWithProviderSwitch() {
  console.log('\n  [3] tasks_delegate with provider switching via metadata');

  const { client, close, availableProviders } = await setup();

  try {
    for (const providerId of availableProviders) {
      console.log(`\n    Delegating to provider: ${providerId}`);

      const result = await client.callTool({
        name: 'tasks_delegate',
        arguments: {
          prompt: 'Say "hello" in one word.',
          agentId: 'factory-multi-agent',
          metadata: { provider: providerId },
          runtimeParams: { temperature: 0, maxTokens: 50 },
        },
      });
      const response = parseToolResult(result);

      check(response.success === true, `${providerId}: tasks_delegate succeeded`);
      assertValidResponse(response, `${providerId}: tasks_delegate`);
    }
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: Multi-Provider Factory API — Live API tests\n');
  console.log(`  Available providers: ${[hasOpenAI && 'openai', hasAnthropic && 'anthropic', hasGemini && 'google-gemini'].filter(Boolean).join(', ')}`);

  await testProviderSwitching();
  await testAgentsDiscoverEnrichedInfo();
  await testTasksDelegateWithProviderSwitch();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
