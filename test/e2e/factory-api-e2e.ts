/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E Test: Factory API — Offline tests through full MCP pipeline.
 *
 * Pipeline: MCP Client → InMemoryTransport → McpAgenticServer → MultiProviderAgent → Mock providers
 *
 * Standalone script — no Jest, no real API keys. Run with:
 *   npx tsx test/e2e/factory-api-e2e.ts
 *
 * Covers:
 * - agents_discover returns enriched provider info (kind, capabilities, displayName, description)
 * - sessions_create → sessions_prompt → sessions_close works with createMultiProviderAgent
 * - tasks_delegate works with factory-created agents
 * - Custom providers via defineProvider work together in one agent
 * - Provider switching via metadata.provider works with factory agents
 * - Error validation: Zod schema rejects invalid options with BridgeError CONFIG
 * - Error validation: createMultiProviderAgent rejects invalid configs with BridgeError CONFIG
 * - Error validation: defineProvider rejects invalid create() results with BridgeError CONFIG
 * - Backward compatibility: old API (plain object) and new API (defineProvider) work together
 *
 * Requirements: 1.4, 1.5, 2.4, 2.5, 2.6, 3.4, 4.4, 5.4, 6.1, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.5, 8.6, 10.1, 10.2, 10.3, 12.1, 12.2, 12.3, 12.4, 12.5
 */

import { z } from 'zod';
import {
  createTestServer,
  parseToolResult,
  check,
  reportAndExit,
} from './providers/_helpers.js';
import { defineProvider } from '../../src/provider/defineProvider.js';
import { createMultiProviderAgent } from '../../src/provider/factories/createMultiProviderAgent.js';
import { openAI } from '../../src/provider/factories/openai.js';
import { anthropic } from '../../src/provider/factories/anthropic.js';
import { BridgeError } from '../../src/errors/BridgeError.js';
import type { AIProvider, ChatMessage, RuntimeParams, AIProviderResult } from '../../src/provider/AIProvider.js';

// ── Mock provider helpers ───────────────────────────────────────

/**
 * Create a minimal AIProvider that echoes prompts with a prefix.
 * Used as the `create` function inside defineProvider.
 *
 * Includes displayName and description as own properties so that
 * ProviderRegistry.list() can read them via duck-typing.
 */
function createMockProvider(
  id: string,
  models: string[],
  prefix: string,
  displayName: string,
  description: string,
): AIProvider {
  return {
    id,
    models,
    displayName,
    description,
    async complete(
      messages: ChatMessage[],
      _params: RuntimeParams,
      _signal?: AbortSignal,
    ): Promise<AIProviderResult> {
      const lastMessage = messages[messages.length - 1];
      const input = lastMessage?.content ?? '';
      return {
        text: `${prefix}: ${input}`,
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  } as AIProvider & { displayName: string; description: string };
}

// ── Define two custom providers via defineProvider ───────────────

const alphaProvider = defineProvider({
  id: 'alpha',
  kind: 'llm',
  displayName: 'Alpha LLM',
  description: 'Mock Alpha provider for testing',
  schema: z.object({
    token: z.string().min(1, 'token must be non-empty'),
    models: z.array(z.string()).nonempty('models must contain at least one model'),
  }),
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    jsonMode: false,
  },
  create: (opts) => createMockProvider('alpha', opts.models, 'ALPHA', 'Alpha LLM', 'Mock Alpha provider for testing'),
});

const betaProvider = defineProvider({
  id: 'beta',
  kind: 'llm',
  displayName: 'Beta LLM',
  description: 'Mock Beta provider for testing',
  schema: z.object({
    token: z.string().min(1, 'token must be non-empty'),
    models: z.array(z.string()).nonempty('models must contain at least one model'),
  }),
  capabilities: {
    streaming: false,
    tools: false,
    vision: true,
    jsonMode: true,
  },
  create: (opts) => createMockProvider('beta', opts.models, 'BETA', 'Beta LLM', 'Mock Beta provider for testing'),
});

// ── Setup ───────────────────────────────────────────────────────

function setup() {
  const providerA = alphaProvider({ token: 'test-token-alpha', models: ['alpha-v1', 'alpha-v2'] });
  const providerB = betaProvider({ token: 'test-token-beta', models: ['beta-v1'] });

  const agent = createMultiProviderAgent({
    id: 'factory-agent',
    providers: [providerA, providerB],
    defaultProviderId: 'alpha',
    capabilities: ['chat', 'factory-test'],
    systemPrompt: 'You are a test assistant.',
  });

  return createTestServer(agent);
}

// ── Tests ───────────────────────────────────────────────────────

async function testAgentsDiscoverEnrichedProviderInfo(): Promise<void> {
  console.log('\n  [1] agents_discover — enriched provider info (kind, capabilities, displayName, description)');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'agents_discover',
      arguments: {},
    });
    const { agents } = parseToolResult(result);

    check(agents.length >= 1, `at least 1 agent discovered (got ${agents.length})`);

    const factoryAgent = agents.find((a: any) => a.id === 'factory-agent');
    check(factoryAgent !== undefined, 'factory-agent found in discovery');

    if (factoryAgent) {
      check(Array.isArray(factoryAgent.providers), 'providers field is an array');
      check(factoryAgent.providers.length === 2, `2 providers registered (got ${factoryAgent.providers?.length})`);

      // Alpha provider — enriched info
      const alpha = factoryAgent.providers.find((p: any) => p.id === 'alpha');
      check(alpha !== undefined, 'alpha provider found in discovery');
      if (alpha) {
        check(alpha.kind === 'llm', `alpha.kind === 'llm' (got "${alpha.kind}")`);
        check(alpha.displayName === 'Alpha LLM', `alpha.displayName === 'Alpha LLM' (got "${alpha.displayName}")`);
        check(alpha.description === 'Mock Alpha provider for testing', `alpha.description correct (got "${alpha.description}")`);
        check(alpha.capabilities !== undefined, 'alpha.capabilities present');
        check(alpha.capabilities?.streaming === true, `alpha.capabilities.streaming === true`);
        check(alpha.capabilities?.tools === true, `alpha.capabilities.tools === true`);
        check(alpha.capabilities?.vision === false, `alpha.capabilities.vision === false`);
        check(alpha.capabilities?.jsonMode === false, `alpha.capabilities.jsonMode === false`);
        check(
          Array.isArray(alpha.models) && alpha.models.length === 2,
          `alpha has 2 models (got ${alpha.models?.length})`,
        );
      }

      // Beta provider — enriched info
      const beta = factoryAgent.providers.find((p: any) => p.id === 'beta');
      check(beta !== undefined, 'beta provider found in discovery');
      if (beta) {
        check(beta.kind === 'llm', `beta.kind === 'llm' (got "${beta.kind}")`);
        check(beta.displayName === 'Beta LLM', `beta.displayName === 'Beta LLM' (got "${beta.displayName}")`);
        check(beta.description === 'Mock Beta provider for testing', `beta.description correct (got "${beta.description}")`);
        check(beta.capabilities !== undefined, 'beta.capabilities present');
        check(beta.capabilities?.streaming === false, `beta.capabilities.streaming === false`);
        check(beta.capabilities?.tools === false, `beta.capabilities.tools === false`);
        check(beta.capabilities?.vision === true, `beta.capabilities.vision === true`);
        check(beta.capabilities?.jsonMode === true, `beta.capabilities.jsonMode === true`);
        check(
          Array.isArray(beta.models) && beta.models.length === 1,
          `beta has 1 model (got ${beta.models?.length})`,
        );
      }
    }
  } finally {
    await close();
  }
}

async function testSessionLifecycle(): Promise<void> {
  console.log('\n  [2] sessions_create → sessions_prompt → sessions_close — factory agent');

  const { client, close } = await setup();

  try {
    // Create session
    const createResult = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'factory-agent' },
    });
    const { sessionId } = parseToolResult(createResult);
    check(typeof sessionId === 'string' && sessionId.length > 0, 'session created');

    // Send prompt
    const promptResult = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId, prompt: 'Hello from e2e test' },
    });
    const response = parseToolResult(promptResult);

    check(typeof response.text === 'string' && response.text.length > 0, 'response text is non-empty');
    check(response.text.includes('ALPHA'), `default provider (alpha) responded (got "${response.text}")`);
    check(response.stopReason === 'end_turn', `stopReason === 'end_turn' (got "${response.stopReason}")`);

    // Check session status
    const statusResult = await client.callTool({
      name: 'sessions_status',
      arguments: { sessionId },
    });
    const status = parseToolResult(statusResult);
    check(status.sessionId === sessionId, 'session status returns correct sessionId');
    check(status.status === 'idle', `session status is 'idle' (got "${status.status}")`);

    // Close session
    const closeResult = await client.callTool({
      name: 'sessions_close',
      arguments: { sessionId },
    });
    const closeData = parseToolResult(closeResult);
    check(closeData.closed === true, 'session closed successfully');
  } finally {
    await close();
  }
}

async function testTasksDelegate(): Promise<void> {
  console.log('\n  [3] tasks_delegate — factory agent one-shot delegation');

  const { client, close } = await setup();

  try {
    const result = await client.callTool({
      name: 'tasks_delegate',
      arguments: {
        prompt: 'Delegate test prompt',
        agentId: 'factory-agent',
      },
    });
    const response = parseToolResult(result);

    check(response.success === true, 'delegation succeeded');
    check(typeof response.text === 'string' && response.text.length > 0, 'response text is non-empty');
    check(response.text.includes('ALPHA'), `default provider (alpha) responded (got "${response.text}")`);
    check(response.stopReason === 'end_turn', `stopReason === 'end_turn' (got "${response.stopReason}")`);
  } finally {
    await close();
  }
}

async function testCustomProvidersWorkTogether(): Promise<void> {
  console.log('\n  [4] Two custom defineProvider providers work together in one agent');

  const { client, close } = await setup();

  try {
    // Session with alpha (default)
    const alphaCreate = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'factory-agent' },
    });
    const { sessionId: alphaSessionId } = parseToolResult(alphaCreate);

    const alphaPrompt = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId: alphaSessionId, prompt: 'test alpha' },
    });
    const alphaResponse = parseToolResult(alphaPrompt);
    check(alphaResponse.text.includes('ALPHA'), `alpha provider responded (got "${alphaResponse.text}")`);

    await client.callTool({ name: 'sessions_close', arguments: { sessionId: alphaSessionId } });

    // Session with beta (via metadata.provider)
    const betaCreate = await client.callTool({
      name: 'sessions_create',
      arguments: {
        agentId: 'factory-agent',
        metadata: { provider: 'beta' },
      },
    });
    const { sessionId: betaSessionId } = parseToolResult(betaCreate);

    const betaPrompt = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId: betaSessionId, prompt: 'test beta' },
    });
    const betaResponse = parseToolResult(betaPrompt);
    check(betaResponse.text.includes('BETA'), `beta provider responded (got "${betaResponse.text}")`);

    await client.callTool({ name: 'sessions_close', arguments: { sessionId: betaSessionId } });
  } finally {
    await close();
  }
}

async function testProviderSwitchingViaMetadata(): Promise<void> {
  console.log('\n  [5] Provider switching via metadata.provider — factory agent');

  const { client, close } = await setup();

  try {
    const providerIds = ['alpha', 'beta'];

    for (const providerId of providerIds) {
      const expectedPrefix = providerId.toUpperCase();

      // Test via sessions_create with metadata.provider
      const createResult = await client.callTool({
        name: 'sessions_create',
        arguments: {
          agentId: 'factory-agent',
          metadata: { provider: providerId },
        },
      });
      const { sessionId } = parseToolResult(createResult);
      check(typeof sessionId === 'string', `${providerId}: session created`);

      const promptResult = await client.callTool({
        name: 'sessions_prompt',
        arguments: { sessionId, prompt: `hello from ${providerId}` },
      });
      const response = parseToolResult(promptResult);
      check(
        response.text.includes(expectedPrefix),
        `${providerId}: correct provider responded (got "${response.text}")`,
      );

      await client.callTool({ name: 'sessions_close', arguments: { sessionId } });

      // Test via tasks_delegate with metadata.provider
      const delegateResult = await client.callTool({
        name: 'tasks_delegate',
        arguments: {
          prompt: `delegate to ${providerId}`,
          agentId: 'factory-agent',
          metadata: { provider: providerId },
        },
      });
      const delegateResponse = parseToolResult(delegateResult);
      check(delegateResponse.success === true, `${providerId}: tasks_delegate succeeded`);
      check(
        delegateResponse.text.includes(expectedPrefix),
        `${providerId}: tasks_delegate used correct provider (got "${delegateResponse.text}")`,
      );
    }
  } finally {
    await close();
  }
}

// ── Error assertion helper ───────────────────────────────────────

/**
 * Assert that a function throws a BridgeError with category CONFIG.
 *
 * @param fn - Function expected to throw.
 * @param label - Test label for logging.
 * @param messageSubstring - Optional substring expected in the error message.
 */
function assertBridgeErrorConfig(fn: () => unknown, label: string, messageSubstring?: string): void {
  try {
    fn();
    // If we get here, the function did NOT throw
    check(false, `${label} — expected BridgeError CONFIG but no error was thrown`);
  } catch (err: unknown) {
    const isBridgeError = err instanceof BridgeError;
    check(isBridgeError, `${label} — threw BridgeError (got ${isBridgeError ? 'BridgeError' : (err as Error)?.constructor?.name ?? typeof err})`);
    if (isBridgeError) {
      const bridgeErr = err as BridgeError;
      check(bridgeErr.type === 'CONFIG', `${label} — type === 'CONFIG' (got "${bridgeErr.type}")`);
      if (messageSubstring) {
        check(
          bridgeErr.message.includes(messageSubstring),
          `${label} — message contains "${messageSubstring}" (got "${bridgeErr.message}")`,
        );
      }
    }
  }
}

// ── Error validation tests ──────────────────────────────────────

async function testOpenAIEmptyApiKeyThrowsConfig(): Promise<void> {
  console.log('\n  [6] openAI({ apiKey: \'\', models: [\'gpt-4o\'] }) — BridgeError CONFIG (Zod validation)');

  assertBridgeErrorConfig(
    () => openAI({ apiKey: '', models: ['gpt-4o'] }),
    'openAI empty apiKey',
    'apiKey',
  );
}

async function testAnthropicEmptyModelsThrowsConfig(): Promise<void> {
  console.log('\n  [7] anthropic({ apiKey: \'key\', models: [] }) — BridgeError CONFIG (Zod validation)');

  assertBridgeErrorConfig(
    () => anthropic({ apiKey: 'key', models: [] as unknown as [string, ...string[]] }),
    'anthropic empty models',
    'models',
  );
}

async function testCreateMultiProviderAgentEmptyProviders(): Promise<void> {
  console.log('\n  [8] createMultiProviderAgent({ providers: [] }) — BridgeError CONFIG');

  assertBridgeErrorConfig(
    () => createMultiProviderAgent({
      id: 'test-agent',
      providers: [],
      defaultProviderId: 'any',
    }),
    'createMultiProviderAgent empty providers',
    'at least one provider',
  );
}

async function testCreateMultiProviderAgentNonexistentDefault(): Promise<void> {
  console.log('\n  [9] createMultiProviderAgent({ defaultProviderId: \'nonexistent\' }) — BridgeError CONFIG');

  const provider = alphaProvider({ token: 'test', models: ['m1'] });

  assertBridgeErrorConfig(
    () => createMultiProviderAgent({
      id: 'test-agent',
      providers: [provider],
      defaultProviderId: 'nonexistent',
    }),
    'createMultiProviderAgent nonexistent defaultProviderId',
    'nonexistent',
  );
}

async function testCreateMultiProviderAgentDuplicateIds(): Promise<void> {
  console.log('\n  [10] createMultiProviderAgent with duplicate provider ids — BridgeError CONFIG');

  const provider1 = alphaProvider({ token: 'test1', models: ['m1'] });
  const provider2 = alphaProvider({ token: 'test2', models: ['m2'] });

  assertBridgeErrorConfig(
    () => createMultiProviderAgent({
      id: 'test-agent',
      providers: [provider1, provider2],
      defaultProviderId: 'alpha',
    }),
    'createMultiProviderAgent duplicate ids',
    'Duplicate provider id',
  );
}

async function testDefineProviderCreateWithoutComplete(): Promise<void> {
  console.log('\n  [11] defineProvider with create() returning object without complete() — BridgeError CONFIG');

  const brokenFactory = defineProvider({
    id: 'broken',
    schema: z.object({ token: z.string().min(1) }),
    create: (_opts) => {
      // Return an object missing the complete() method
      return { id: 'broken', models: ['m1'] } as unknown as AIProvider;
    },
  });

  assertBridgeErrorConfig(
    () => brokenFactory({ token: 'test' }),
    'defineProvider create() without complete()',
    'complete()',
  );
}

// ── Backward compatibility: old API + new API together ──────────

/**
 * Create a "legacy" provider — a plain object implementing AIProvider
 * with only id, models, and complete(). No kind, no capabilities,
 * no displayName, no description. This is how providers were created
 * before the Factory API.
 */
function createLegacyProvider(
  id: string,
  models: string[],
  prefix: string,
): AIProvider {
  return {
    id,
    models,
    async complete(
      messages: ChatMessage[],
      _params: RuntimeParams,
      _signal?: AbortSignal,
    ): Promise<AIProviderResult> {
      const lastMessage = messages[messages.length - 1];
      const input = lastMessage?.content ?? '';
      return {
        text: `${prefix}: ${input}`,
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 3 },
      };
    },
  };
}

/**
 * Setup for backward compatibility test: one legacy provider (plain object)
 * and one new provider (via defineProvider), combined in createMultiProviderAgent.
 */
function setupBackwardCompat() {
  // Legacy provider — plain object, no kind/capabilities/displayName/description
  const legacyProv = createLegacyProvider('legacy-custom', ['legacy-model-1'], 'LEGACY');

  // New provider — via defineProvider, with full metadata
  const newProv = alphaProvider({ token: 'test-token-alpha', models: ['alpha-v1'] });

  const agent = createMultiProviderAgent({
    id: 'compat-agent',
    providers: [legacyProv, newProv],
    defaultProviderId: 'legacy-custom',
    capabilities: ['chat', 'compat-test'],
  });

  return createTestServer(agent);
}

async function testBackwardCompatDiscovery(): Promise<void> {
  console.log('\n  [12] Backward compat: agents_discover — legacy provider omits kind/capabilities, new provider has enriched info');

  const { client, close } = await setupBackwardCompat();

  try {
    const result = await client.callTool({
      name: 'agents_discover',
      arguments: {},
    });
    const { agents } = parseToolResult(result);

    const compatAgent = agents.find((a: any) => a.id === 'compat-agent');
    check(compatAgent !== undefined, 'compat-agent found in discovery');

    if (compatAgent) {
      check(Array.isArray(compatAgent.providers), 'providers field is an array');
      check(compatAgent.providers.length === 2, `2 providers registered (got ${compatAgent.providers?.length})`);

      // Legacy provider — no kind, no capabilities, no displayName, no description
      const legacy = compatAgent.providers.find((p: any) => p.id === 'legacy-custom');
      check(legacy !== undefined, 'legacy-custom provider found in discovery');
      if (legacy) {
        check(legacy.kind === undefined, `legacy provider: kind is omitted (got ${JSON.stringify(legacy.kind)})`);
        check(legacy.capabilities === undefined, `legacy provider: capabilities is omitted (got ${JSON.stringify(legacy.capabilities)})`);
        check(legacy.displayName === undefined, `legacy provider: displayName is omitted (got ${JSON.stringify(legacy.displayName)})`);
        check(legacy.description === undefined, `legacy provider: description is omitted (got ${JSON.stringify(legacy.description)})`);
        check(
          Array.isArray(legacy.models) && legacy.models.length === 1 && legacy.models[0] === 'legacy-model-1',
          `legacy provider: models correct (got ${JSON.stringify(legacy.models)})`,
        );
      }

      // New provider (via defineProvider) — enriched info
      const alpha = compatAgent.providers.find((p: any) => p.id === 'alpha');
      check(alpha !== undefined, 'alpha provider found in discovery');
      if (alpha) {
        check(alpha.kind === 'llm', `alpha provider: kind === 'llm' (got "${alpha.kind}")`);
        check(alpha.capabilities !== undefined, 'alpha provider: capabilities present');
        check(alpha.capabilities?.streaming === true, 'alpha provider: capabilities.streaming === true');
        check(alpha.capabilities?.tools === true, 'alpha provider: capabilities.tools === true');
        check(alpha.displayName === 'Alpha LLM', `alpha provider: displayName === 'Alpha LLM' (got "${alpha.displayName}")`);
        check(alpha.description === 'Mock Alpha provider for testing', `alpha provider: description correct (got "${alpha.description}")`);
      }
    }
  } finally {
    await close();
  }
}

async function testBackwardCompatProviderSwitching(): Promise<void> {
  console.log('\n  [13] Backward compat: both legacy and new providers respond to prompts via provider switching');

  const { client, close } = await setupBackwardCompat();

  try {
    // Default provider is legacy-custom — test without metadata
    const defaultCreate = await client.callTool({
      name: 'sessions_create',
      arguments: { agentId: 'compat-agent' },
    });
    const { sessionId: defaultSessionId } = parseToolResult(defaultCreate);

    const defaultPrompt = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId: defaultSessionId, prompt: 'hello default' },
    });
    const defaultResponse = parseToolResult(defaultPrompt);
    check(
      defaultResponse.text.includes('LEGACY'),
      `default provider (legacy) responded (got "${defaultResponse.text}")`,
    );

    await client.callTool({ name: 'sessions_close', arguments: { sessionId: defaultSessionId } });

    // Switch to alpha provider via metadata.provider
    const alphaCreate = await client.callTool({
      name: 'sessions_create',
      arguments: {
        agentId: 'compat-agent',
        metadata: { provider: 'alpha' },
      },
    });
    const { sessionId: alphaSessionId } = parseToolResult(alphaCreate);

    const alphaPrompt = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId: alphaSessionId, prompt: 'hello alpha' },
    });
    const alphaResponse = parseToolResult(alphaPrompt);
    check(
      alphaResponse.text.includes('ALPHA'),
      `alpha provider responded via switching (got "${alphaResponse.text}")`,
    );

    await client.callTool({ name: 'sessions_close', arguments: { sessionId: alphaSessionId } });

    // Switch back to legacy via metadata.provider
    const legacyCreate = await client.callTool({
      name: 'sessions_create',
      arguments: {
        agentId: 'compat-agent',
        metadata: { provider: 'legacy-custom' },
      },
    });
    const { sessionId: legacySessionId } = parseToolResult(legacyCreate);

    const legacyPrompt = await client.callTool({
      name: 'sessions_prompt',
      arguments: { sessionId: legacySessionId, prompt: 'hello legacy explicit' },
    });
    const legacyResponse = parseToolResult(legacyPrompt);
    check(
      legacyResponse.text.includes('LEGACY'),
      `legacy provider responded via explicit switching (got "${legacyResponse.text}")`,
    );

    await client.callTool({ name: 'sessions_close', arguments: { sessionId: legacySessionId } });

    // Also test tasks_delegate with provider switching
    const delegateLegacy = await client.callTool({
      name: 'tasks_delegate',
      arguments: {
        prompt: 'delegate to legacy',
        agentId: 'compat-agent',
      },
    });
    const delegateLegacyResponse = parseToolResult(delegateLegacy);
    check(delegateLegacyResponse.success === true, 'tasks_delegate to legacy succeeded');
    check(
      delegateLegacyResponse.text.includes('LEGACY'),
      `tasks_delegate default (legacy) responded (got "${delegateLegacyResponse.text}")`,
    );

    const delegateAlpha = await client.callTool({
      name: 'tasks_delegate',
      arguments: {
        prompt: 'delegate to alpha',
        agentId: 'compat-agent',
        metadata: { provider: 'alpha' },
      },
    });
    const delegateAlphaResponse = parseToolResult(delegateAlpha);
    check(delegateAlphaResponse.success === true, 'tasks_delegate to alpha succeeded');
    check(
      delegateAlphaResponse.text.includes('ALPHA'),
      `tasks_delegate alpha responded (got "${delegateAlphaResponse.text}")`,
    );
  } finally {
    await close();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('E2E: Factory API — Offline tests through full MCP pipeline\n');

  await testAgentsDiscoverEnrichedProviderInfo();
  await testSessionLifecycle();
  await testTasksDelegate();
  await testCustomProvidersWorkTogether();
  await testProviderSwitchingViaMetadata();
  await testOpenAIEmptyApiKeyThrowsConfig();
  await testAnthropicEmptyModelsThrowsConfig();
  await testCreateMultiProviderAgentEmptyProviders();
  await testCreateMultiProviderAgentNonexistentDefault();
  await testCreateMultiProviderAgentDuplicateIds();
  await testDefineProviderCreateWithoutComplete();
  await testBackwardCompatDiscovery();
  await testBackwardCompatProviderSwitching();

  reportAndExit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
