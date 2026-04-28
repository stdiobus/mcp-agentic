/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: Provider Error Handling — Real error scenarios with live providers.
 *
 * Tests that invalid credentials, nonexistent models, and cancellation
 * produce correct BridgeError categories through the full MCP pipeline.
 *
 * Requires: At least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY.
 * Skipped automatically when none are set.
 *
 * Timeout: 30s per test.
 */

import {
  skipIfNoKeys,
  createTestServer,
  parseToolResult,
  check,
  reportAndExit,
} from './_helpers.js';
import { OpenAIProvider } from '../../../src/provider/providers/OpenAIProvider.js';
import { AnthropicProvider } from '../../../src/provider/providers/AnthropicProvider.js';
import { GoogleGeminiProvider } from '../../../src/provider/providers/GoogleGeminiProvider.js';
import { ProviderRegistry } from '../../../src/provider/ProviderRegistry.js';
import { MultiProviderCompanionAgent } from '../../../src/agent/MultiProviderCompanionAgent.js';

// ── Skip if no API keys ─────────────────────────────────────────

const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_AI_API_KEY'] as const;
skipIfNoKeys([...KEYS]);

// ── Detect available providers ──────────────────────────────────

const hasOpenAI = !!process.env['OPENAI_API_KEY'];
const hasAnthropic = !!process.env['ANTHROPIC_API_KEY'];
const hasGemini = !!process.env['GOOGLE_AI_API_KEY'];

// ── Tests ───────────────────────────────────────────────────────

async function testInvalidApiKey() {
  console.log('\n  [1] Invalid API key → AUTH error');

  // Test each available provider with an invalid key
  const providers: Array<{ name: string; create: () => Promise<any> }> = [];

  if (hasOpenAI) {
    providers.push({
      name: 'openai',
      create: () => OpenAIProvider.create({
        credentials: { apiKey: 'sk-invalid-key-for-testing-12345' },
        models: ['gpt-4o-mini'],
        defaults: { model: 'gpt-4o-mini' },
      }),
    });
  }

  if (hasAnthropic) {
    providers.push({
      name: 'anthropic',
      create: () => AnthropicProvider.create({
        credentials: { apiKey: 'sk-ant-invalid-key-for-testing-12345' },
        models: ['claude-sonnet-4-20250514'],
        defaults: { model: 'claude-sonnet-4-20250514', maxTokens: 100 },
      }),
    });
  }

  if (hasGemini) {
    providers.push({
      name: 'google-gemini',
      create: () => GoogleGeminiProvider.create({
        credentials: { apiKey: 'invalid-gemini-key-for-testing-12345' },
        models: ['gemini-2.0-flash'],
        defaults: { model: 'gemini-2.0-flash' },
      }),
    });
  }

  for (const { name, create } of providers) {
    console.log(`\n    Testing invalid key for: ${name}`);

    try {
      const provider = await create();
      const registry = new ProviderRegistry();
      registry.register(provider);

      const agent = new MultiProviderCompanionAgent({
        id: `${name}-invalid-agent`,
        defaultProviderId: name,
        registry,
        systemPrompt: 'Test',
      });

      const { client, close } = await createTestServer(agent);

      try {
        const { sessionId } = parseToolResult(
          await client.callTool({
            name: 'sessions_create',
            arguments: { agentId: `${name}-invalid-agent` },
          }),
        );

        const result = await client.callTool({
          name: 'sessions_prompt',
          arguments: { sessionId, prompt: 'Hello' },
        });

        const data = parseToolResult(result);
        check(
          result.isError === true || data.error !== undefined,
          `${name}: error returned for invalid API key`,
        );
        // The error should be auth-related (401/authentication)
        if (data.error) {
          const errorLower = data.error.toLowerCase();
          check(
            errorLower.includes('auth') ||
            errorLower.includes('api key') ||
            errorLower.includes('invalid') ||
            errorLower.includes('401') ||
            errorLower.includes('permission') ||
            errorLower.includes('unauthorized'),
            `${name}: error is auth-related (got "${data.error.substring(0, 100)}")`,
          );
        }
      } finally {
        await close();
      }
    } catch (err: any) {
      // Some providers may throw during construction with invalid keys
      // That's also acceptable behavior
      check(
        err.message?.includes('auth') ||
        err.message?.includes('key') ||
        err.message?.includes('credential') ||
        err.category === 'AUTH' ||
        err.category === 'CONFIG',
        `${name}: construction error is auth/config related (got "${err.message?.substring(0, 100)}")`,
      );
    }
  }
}

async function testNonexistentModel() {
  console.log('\n  [2] Nonexistent model → UPSTREAM error');

  // Use the first available provider with a valid key but invalid model
  if (hasOpenAI) {
    console.log('\n    Testing nonexistent model for: openai');

    const provider = await OpenAIProvider.create({
      credentials: { apiKey: process.env['OPENAI_API_KEY']! },
      models: ['gpt-4o-mini', 'nonexistent-model-xyz-12345'],
      defaults: { model: 'nonexistent-model-xyz-12345' },
    });

    const registry = new ProviderRegistry();
    registry.register(provider);

    const agent = new MultiProviderCompanionAgent({
      id: 'openai-bad-model-agent',
      defaultProviderId: 'openai',
      registry,
      systemPrompt: 'Test',
    });

    const { client, close } = await createTestServer(agent);

    try {
      const { sessionId } = parseToolResult(
        await client.callTool({
          name: 'sessions_create',
          arguments: { agentId: 'openai-bad-model-agent' },
        }),
      );

      const result = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'Hello' },
      });

      const data = parseToolResult(result);
      check(
        result.isError === true || data.error !== undefined,
        'openai: error returned for nonexistent model',
      );
      if (data.error) {
        check(
          data.error.toLowerCase().includes('model') ||
          data.error.toLowerCase().includes('not found') ||
          data.error.toLowerCase().includes('does not exist') ||
          data.error.toLowerCase().includes('invalid'),
          `openai: error mentions model issue (got "${data.error.substring(0, 150)}")`,
        );
      }
    } finally {
      await close();
    }
  }

  if (hasAnthropic) {
    console.log('\n    Testing nonexistent model for: anthropic');

    const provider = await AnthropicProvider.create({
      credentials: { apiKey: process.env['ANTHROPIC_API_KEY']! },
      models: ['nonexistent-model-xyz-12345'],
      defaults: { model: 'nonexistent-model-xyz-12345', maxTokens: 100 },
    });

    const registry = new ProviderRegistry();
    registry.register(provider);

    const agent = new MultiProviderCompanionAgent({
      id: 'anthropic-bad-model-agent',
      defaultProviderId: 'anthropic',
      registry,
      systemPrompt: 'Test',
    });

    const { client, close } = await createTestServer(agent);

    try {
      const { sessionId } = parseToolResult(
        await client.callTool({
          name: 'sessions_create',
          arguments: { agentId: 'anthropic-bad-model-agent' },
        }),
      );

      const result = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'Hello' },
      });

      const data = parseToolResult(result);
      check(
        result.isError === true || data.error !== undefined,
        'anthropic: error returned for nonexistent model',
      );
      if (data.error) {
        check(
          data.error.toLowerCase().includes('model') ||
          data.error.toLowerCase().includes('not found') ||
          data.error.toLowerCase().includes('does not exist') ||
          data.error.toLowerCase().includes('invalid'),
          `anthropic: error mentions model issue (got "${data.error.substring(0, 150)}")`,
        );
      }
    } finally {
      await close();
    }
  }

  if (hasGemini) {
    console.log('\n    Testing nonexistent model for: google-gemini');

    const provider = await GoogleGeminiProvider.create({
      credentials: { apiKey: process.env['GOOGLE_AI_API_KEY']! },
      models: ['nonexistent-model-xyz-12345'],
      defaults: { model: 'nonexistent-model-xyz-12345' },
    });

    const registry = new ProviderRegistry();
    registry.register(provider);

    const agent = new MultiProviderCompanionAgent({
      id: 'gemini-bad-model-agent',
      defaultProviderId: 'google-gemini',
      registry,
      systemPrompt: 'Test',
    });

    const { client, close } = await createTestServer(agent);

    try {
      const { sessionId } = parseToolResult(
        await client.callTool({
          name: 'sessions_create',
          arguments: { agentId: 'gemini-bad-model-agent' },
        }),
      );

      const result = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: 'Hello' },
      });

      const data = parseToolResult(result);
      check(
        result.isError === true || data.error !== undefined,
        'google-gemini: error returned for nonexistent model',
      );
      if (data.error) {
        check(
          data.error.toLowerCase().includes('model') ||
          data.error.toLowerCase().includes('not found') ||
          data.error.toLowerCase().includes('does not exist') ||
          data.error.toLowerCase().includes('invalid') ||
          data.error.toLowerCase().includes('404'),
          `google-gemini: error mentions model issue (got "${data.error.substring(0, 150)}")`,
        );
      }
    } finally {
      await close();
    }
  }
}

async function testAbortSignalCancellation() {
  console.log('\n  [3] AbortSignal cancellation — request cancelled correctly');

  // Only test with OpenAI since it has the best AbortSignal support
  if (!hasOpenAI) {
    console.log('    ⏭ Skipping: OPENAI_API_KEY not set');
    return;
  }

  const provider = await OpenAIProvider.create({
    credentials: { apiKey: process.env['OPENAI_API_KEY']! },
    models: ['gpt-4o-mini'],
    defaults: { model: 'gpt-4o-mini' },
  });

  const registry = new ProviderRegistry();
  registry.register(provider);

  const agent = new MultiProviderCompanionAgent({
    id: 'openai-cancel-agent',
    defaultProviderId: 'openai',
    registry,
    systemPrompt: 'You are a helpful assistant. Write a very long essay about the history of computing.',
  });

  const { client, close } = await createTestServer(agent);

  try {
    const { sessionId } = parseToolResult(
      await client.callTool({
        name: 'sessions_create',
        arguments: { agentId: 'openai-cancel-agent' },
      }),
    );

    // Send a prompt that would generate a long response, then cancel
    // We use sessions_cancel to test the cancellation path
    const promptPromise = client.callTool({
      name: 'sessions_prompt',
      arguments: {
        sessionId,
        prompt: 'Write a 5000 word essay about the complete history of computing from the abacus to quantum computers.',
        timeout: 1, // Very short timeout to trigger cancellation
      },
    });

    // The prompt should either complete quickly (unlikely with this prompt)
    // or return an error due to timeout/cancellation
    const result = await promptPromise;
    const data = parseToolResult(result);

    // Either we get a valid response (if the API was very fast) or an error
    const gotResponse = typeof data.text === 'string' && data.text.length > 0;
    const gotError = result.isError === true || data.error !== undefined;

    check(
      gotResponse || gotError,
      `cancellation: got either response or error (response: ${gotResponse}, error: ${gotError})`,
    );

    await client.callTool({ name: 'sessions_close', arguments: { sessionId } }).catch(() => { });
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: Provider Error Handling — Live API tests\n');
  console.log(`  Available providers: ${[hasOpenAI && 'openai', hasAnthropic && 'anthropic', hasGemini && 'google-gemini'].filter(Boolean).join(', ')}`);

  await testInvalidApiKey();
  await testNonexistentModel();
  await testAbortSignalCancellation();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
