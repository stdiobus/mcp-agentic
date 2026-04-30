/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for interoperability and enriched discovery.
 *
 * Property 7: Enriched discovery — kind and capabilities in agents_discover response.
 * Property 8: Defaults for kind and capabilities on providers without metadata.
 * Property 10: Interoperability of custom and built-in providers.
 *
 * **Validates: Requirements 2.4, 2.5, 7.1, 7.2, 7.3, 7.4, 7.5, 12.1, 12.2, 12.3**
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as fc from 'fast-check';
import { z } from 'zod';
import { handleCombinedDiscover } from '../../../../src/mcp/tools/agents.js';
import { InProcessExecutor } from '../../../../src/executor/InProcessExecutor.js';
import { ProviderRegistry } from '../../../../src/provider/ProviderRegistry.js';
import { MultiProviderAgent } from '../../../../src/agent/MultiProviderAgent.js';
import { defineProvider } from '../../../../src/provider/defineProvider.js';
import { createMultiProviderAgent } from '../../../../src/provider/factories/createMultiProviderAgent.js';
import type {
  AIProvider,
  AIProviderResult,
  ProviderKind,
  ProviderCapabilities,
  RuntimeParams,
  ChatMessage,
} from '../../../../src/provider/AIProvider.js';
import type { AgentInfo } from '../../../../src/executor/types.js';

// ── Helpers ─────────────────────────────────────────────────────

const defaultResult: AIProviderResult = { text: 'response', stopReason: 'end_turn' };

/** Create a bare AIProvider with no kind/capabilities metadata. */
function createBareProvider(
  id: string,
  models: string[] = ['model-1'],
): AIProvider {
  return {
    id,
    models: Object.freeze(models),
    complete: jest.fn<any>().mockResolvedValue(defaultResult),
  };
}

/** Create an AIProvider with enriched metadata fields. */
function createEnrichedProvider(
  id: string,
  models: string[],
  extra: {
    kind?: ProviderKind;
    capabilities?: ProviderCapabilities;
    displayName?: string;
    description?: string;
  } = {},
): AIProvider & Record<string, unknown> {
  return {
    id,
    models: Object.freeze(models),
    ...(extra.kind !== undefined ? { kind: extra.kind } : {}),
    ...(extra.capabilities !== undefined ? { capabilities: extra.capabilities } : {}),
    ...(extra.displayName !== undefined ? { displayName: extra.displayName } : {}),
    ...(extra.description !== undefined ? { description: extra.description } : {}),
    complete: jest.fn<any>().mockResolvedValue(defaultResult),
  };
}

/** Create a bare AIProvider that also has a stream() method. */
function createStreamableProvider(
  id: string,
  models: string[] = ['model-1'],
): AIProvider & { stream: () => void } {
  return {
    id,
    models: Object.freeze(models),
    complete: jest.fn<any>().mockResolvedValue(defaultResult),
    stream: () => { /* noop */ },
  };
}

/** Set up an InProcessExecutor with a MultiProviderAgent and return parsed discovery. */
async function discoverWithProviders(
  providers: AIProvider[],
): Promise<AgentInfo[]> {
  const registry = new ProviderRegistry();
  for (const p of providers) {
    registry.register(p);
  }

  const agent = new MultiProviderAgent({
    id: 'test-agent',
    defaultProviderId: providers[0]!.id,
    registry,
    capabilities: ['chat'],
  });

  const executor = new InProcessExecutor({ silent: true });
  executor.register(agent);
  await executor.start();

  try {
    const result = await handleCombinedDiscover(executor, undefined, {});
    const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };
    return parsed.agents;
  } finally {
    await executor.close();
  }
}

// ── fast-check arbitraries ──────────────────────────────────────

/** Arbitrary for valid provider IDs. */
const arbProviderId = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/);

/** Arbitrary for model name strings. */
const arbModelName = fc.stringMatching(/^[a-z][a-z0-9._-]{0,29}$/);

/** Arbitrary for non-empty model arrays. */
const arbModels = fc.array(arbModelName, { minLength: 1, maxLength: 3 });

/** Arbitrary for ProviderKind values. */
const arbProviderKind: fc.Arbitrary<ProviderKind> = fc.constantFrom('llm', 'embedding', 'reranker');

/** Arbitrary for ProviderCapabilities with at least one field set. */
const arbNonEmptyCapabilities: fc.Arbitrary<ProviderCapabilities> = fc.record({
  streaming: fc.boolean(),
  tools: fc.boolean(),
  vision: fc.boolean(),
  jsonMode: fc.boolean(),
});

/** Arbitrary for a non-empty display name. */
const arbDisplayName = fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0);

/** Arbitrary for a non-empty description. */
const arbDescription = fc.string({ minLength: 1, maxLength: 60 }).filter(s => s.trim().length > 0);

// ── Property 7: Enriched discovery — kind and capabilities ──────

// Feature: provider-factory-api, Property 7: Enriched discovery — kind and capabilities
describe('Property 7: Enriched discovery — kind and capabilities', () => {
  it('property: providers with kind and capabilities → agents_discover includes these fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProviderId,
        arbModels,
        arbProviderKind,
        arbNonEmptyCapabilities,
        async (id, models, kind, capabilities) => {
          const provider = createEnrichedProvider(id, models, { kind, capabilities });
          const agents = await discoverWithProviders([provider]);

          expect(agents).toHaveLength(1);
          const providerInfo = agents[0]!.providers;
          expect(providerInfo).toBeDefined();
          expect(providerInfo).toHaveLength(1);
          expect(providerInfo![0]!.kind).toBe(kind);
          expect(providerInfo![0]!.capabilities).toEqual(capabilities);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: providers without kind → agents_discover omits kind field (ProviderRegistry behavior)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProviderId,
        arbModels,
        async (id, models) => {
          const provider = createBareProvider(id, models);
          const agents = await discoverWithProviders([provider]);

          expect(agents).toHaveLength(1);
          const providerInfo = agents[0]!.providers!;
          expect(providerInfo).toHaveLength(1);
          // ProviderRegistry.list() omits kind when provider doesn't declare it
          expect(providerInfo[0]).not.toHaveProperty('kind');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: providers without capabilities → agents_discover omits capabilities field', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProviderId,
        arbModels,
        async (id, models) => {
          const provider = createBareProvider(id, models);
          const agents = await discoverWithProviders([provider]);

          expect(agents).toHaveLength(1);
          const providerInfo = agents[0]!.providers!;
          expect(providerInfo).toHaveLength(1);
          expect(providerInfo[0]).not.toHaveProperty('capabilities');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: providers with displayName and description → agents_discover includes them', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProviderId,
        arbModels,
        arbDisplayName,
        arbDescription,
        async (id, models, displayName, description) => {
          const provider = createEnrichedProvider(id, models, { displayName, description });
          const agents = await discoverWithProviders([provider]);

          const providerInfo = agents[0]!.providers!;
          expect(providerInfo[0]!.displayName).toBe(displayName);
          expect(providerInfo[0]!.description).toBe(description);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: mixed enriched and bare providers → correct selective inclusion', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProviderId,
        arbModels,
        arbProviderKind,
        arbNonEmptyCapabilities,
        arbDisplayName,
        arbDescription,
        arbProviderId.filter(id => id.length > 1),
        arbModels,
        async (enrichedId, enrichedModels, kind, caps, displayName, desc, bareIdBase, bareModels) => {
          // Ensure unique IDs
          const bareId = bareIdBase === enrichedId ? `x${bareIdBase}` : bareIdBase;

          const enriched = createEnrichedProvider(enrichedId, enrichedModels, {
            kind,
            capabilities: caps,
            displayName,
            description: desc,
          });
          const bare = createBareProvider(bareId, bareModels);

          const agents = await discoverWithProviders([enriched, bare]);

          const providers = agents[0]!.providers!;
          expect(providers).toHaveLength(2);

          const enrichedInfo = providers.find(p => p.id === enrichedId)!;
          expect(enrichedInfo.kind).toBe(kind);
          expect(enrichedInfo.capabilities).toEqual(caps);
          expect(enrichedInfo.displayName).toBe(displayName);
          expect(enrichedInfo.description).toBe(desc);

          const bareInfo = providers.find(p => p.id === bareId)!;
          expect(bareInfo).not.toHaveProperty('kind');
          expect(bareInfo).not.toHaveProperty('capabilities');
          expect(bareInfo).not.toHaveProperty('displayName');
          expect(bareInfo).not.toHaveProperty('description');
        },
      ),
      { numRuns: 50 },
    );
  });
});


// ── Property 8: Defaults for kind and capabilities ──────────────

// Feature: provider-factory-api, Property 8: Defaults for kind and capabilities for providers without metadata
describe('Property 8: Defaults for kind and capabilities for providers without metadata', () => {
  it('property: defineProvider defaults kind to "llm" when not specified', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbModels,
        (id, models) => {
          const factory = defineProvider({
            id,
            schema: z.object({ key: z.string().min(1) }),
            create: () => ({
              id,
              models: Object.freeze(models),
              complete: jest.fn<any>().mockResolvedValue(defaultResult),
            }),
            // kind intentionally omitted
          });

          // Static metadata defaults to 'llm'
          expect(factory.kind).toBe('llm');

          // Instance also gets kind: 'llm'
          const provider = factory({ key: 'test' });
          expect(provider.kind).toBe('llm');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: defineProvider infers streaming: true when provider has stream() method', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbModels,
        (id, models) => {
          const factory = defineProvider({
            id,
            schema: z.object({ key: z.string().min(1) }),
            create: () => ({
              id,
              models: Object.freeze(models),
              complete: jest.fn<any>().mockResolvedValue(defaultResult),
              stream: () => { /* noop */ },
            }),
            // capabilities intentionally omitted → defaults to {}
          });

          const provider = factory({ key: 'test' });

          // streaming should be inferred as true from stream() method presence
          expect(provider.capabilities?.streaming).toBe(true);
          // Other capabilities default to false
          expect(provider.capabilities?.tools).toBe(false);
          expect(provider.capabilities?.vision).toBe(false);
          expect(provider.capabilities?.jsonMode).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: defineProvider defaults streaming to false when provider has no stream() method', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbModels,
        (id, models) => {
          const factory = defineProvider({
            id,
            schema: z.object({ key: z.string().min(1) }),
            create: () => ({
              id,
              models: Object.freeze(models),
              complete: jest.fn<any>().mockResolvedValue(defaultResult),
              // no stream() method
            }),
            // capabilities intentionally omitted
          });

          const provider = factory({ key: 'test' });

          // All capabilities default to false when no stream() and no config capabilities
          expect(provider.capabilities?.streaming).toBe(false);
          expect(provider.capabilities?.tools).toBe(false);
          expect(provider.capabilities?.vision).toBe(false);
          expect(provider.capabilities?.jsonMode).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: ProviderRegistry.list() omits kind for bare providers (no kind field)', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbModels,
        (id, models) => {
          const registry = new ProviderRegistry();
          registry.register(createBareProvider(id, models));

          const listed = registry.list();
          expect(listed).toHaveLength(1);
          expect(listed[0]).not.toHaveProperty('kind');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: ProviderRegistry.list() omits capabilities for bare providers (no capabilities field)', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbModels,
        (id, models) => {
          const registry = new ProviderRegistry();
          registry.register(createBareProvider(id, models));

          const listed = registry.list();
          expect(listed).toHaveLength(1);
          expect(listed[0]).not.toHaveProperty('capabilities');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: provider capabilities from defineProvider config override base defaults', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbModels,
        arbNonEmptyCapabilities,
        (id, models, configCaps) => {
          const factory = defineProvider({
            id,
            schema: z.object({ key: z.string().min(1) }),
            create: () => ({
              id,
              models: Object.freeze(models),
              complete: jest.fn<any>().mockResolvedValue(defaultResult),
            }),
            capabilities: configCaps,
          });

          const provider = factory({ key: 'test' });

          // Config capabilities should override base defaults
          expect(provider.capabilities?.streaming).toBe(configCaps.streaming);
          expect(provider.capabilities?.tools).toBe(configCaps.tools);
          expect(provider.capabilities?.vision).toBe(configCaps.vision);
          expect(provider.capabilities?.jsonMode).toBe(configCaps.jsonMode);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 10: Interoperability of custom and built-in providers ──

// Feature: provider-factory-api, Property 10: Interoperability of custom and built-in providers
describe('Property 10: Interoperability of custom and built-in providers', () => {
  /**
   * Create a custom provider via defineProvider with arbitrary metadata.
   * Returns both the factory and a provider instance.
   */
  function createCustomViaDefineProvider(
    id: string,
    models: string[],
    kind: ProviderKind = 'llm',
    capabilities: ProviderCapabilities = {},
    displayName?: string,
    description?: string,
  ) {
    const schema = z.object({
      token: z.string().min(1),
      models: z.array(z.string()).nonempty(),
    });

    const factory = defineProvider({
      id,
      schema,
      kind,
      capabilities,
      displayName: displayName ?? id,
      description: description ?? '',
      create: (opts) => ({
        id,
        models: Object.freeze(opts.models),
        complete: jest.fn<any>().mockResolvedValue(defaultResult),
      }),
    });

    return factory({ token: 'test-token', models });
  }

  /**
   * Create a "built-in-like" provider that mimics the pattern of openAI/anthropic/gemini
   * factories (provider with kind, capabilities, displayName, description attached).
   */
  function createBuiltinLikeProvider(
    id: string,
    models: string[],
    kind: ProviderKind,
    capabilities: ProviderCapabilities,
    displayName: string,
    description: string,
  ): AIProvider & Record<string, unknown> {
    return {
      id,
      models: Object.freeze(models),
      kind,
      capabilities,
      displayName,
      description,
      complete: jest.fn<any>().mockResolvedValue(defaultResult),
    };
  }

  it('property: custom defineProvider provider + built-in provider both work in ProviderRegistry', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbModels,
        arbProviderKind,
        arbNonEmptyCapabilities,
        arbProviderId.filter(id => id.length > 1),
        arbModels,
        (customId, customModels, customKind, customCaps, builtinIdBase, builtinModels) => {
          const builtinId = builtinIdBase === customId ? `b${builtinIdBase}` : builtinIdBase;

          const customProvider = createCustomViaDefineProvider(
            customId, customModels, customKind, customCaps,
          );
          const builtinProvider = createBuiltinLikeProvider(
            builtinId, builtinModels, 'llm',
            { streaming: true, tools: true, vision: true, jsonMode: true },
            'BuiltIn', 'A built-in provider',
          );

          const registry = new ProviderRegistry();
          registry.register(customProvider);
          registry.register(builtinProvider);

          // Both should be retrievable
          expect(registry.get(customId)).toBe(customProvider);
          expect(registry.get(builtinId)).toBe(builtinProvider);

          // list() should contain both
          const listed = registry.list();
          expect(listed).toHaveLength(2);

          const customInfo = listed.find(p => p.id === customId)!;
          expect(customInfo).toBeDefined();
          expect([...customInfo.models]).toEqual(customModels);

          const builtinInfo = listed.find(p => p.id === builtinId)!;
          expect(builtinInfo).toBeDefined();
          expect([...builtinInfo.models]).toEqual(builtinModels);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: custom defineProvider provider + built-in provider both work in createMultiProviderAgent', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbModels,
        arbProviderKind,
        arbNonEmptyCapabilities,
        arbProviderId.filter(id => id.length > 1),
        arbModels,
        (customId, customModels, customKind, customCaps, builtinIdBase, builtinModels) => {
          const builtinId = builtinIdBase === customId ? `b${builtinIdBase}` : builtinIdBase;

          const customProvider = createCustomViaDefineProvider(
            customId, customModels, customKind, customCaps,
          );
          const builtinProvider = createBuiltinLikeProvider(
            builtinId, builtinModels, 'llm',
            { streaming: true, tools: true, vision: true, jsonMode: true },
            'BuiltIn', 'A built-in provider',
          );

          const agent = createMultiProviderAgent({
            id: 'interop-agent',
            providers: [customProvider, builtinProvider],
            defaultProviderId: customProvider.id,
          });

          expect(agent).toBeInstanceOf(MultiProviderAgent);

          const registryList = agent.getProviderRegistry().list();
          expect(registryList).toHaveLength(2);

          const customEntry = registryList.find(p => p.id === customId);
          const builtinEntry = registryList.find(p => p.id === builtinId);
          expect(customEntry).toBeDefined();
          expect(builtinEntry).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: agents_discover includes metadata from both custom and built-in providers', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProviderId,
        arbModels,
        arbProviderKind,
        arbNonEmptyCapabilities,
        arbDisplayName,
        arbDescription,
        arbProviderId.filter(id => id.length > 1),
        arbModels,
        arbDisplayName,
        arbDescription,
        async (
          customId, customModels, customKind, customCaps, customDisplay, customDesc,
          builtinIdBase, builtinModels, builtinDisplay, builtinDesc,
        ) => {
          const builtinId = builtinIdBase === customId ? `b${builtinIdBase}` : builtinIdBase;

          const customProvider = createCustomViaDefineProvider(
            customId, customModels, customKind, customCaps, customDisplay, customDesc,
          );
          const builtinProvider = createBuiltinLikeProvider(
            builtinId, builtinModels, 'llm',
            { streaming: true, tools: true, vision: true, jsonMode: true },
            builtinDisplay, builtinDesc,
          );

          const agents = await discoverWithProviders([customProvider, builtinProvider]);

          expect(agents).toHaveLength(1);
          const providers = agents[0]!.providers!;
          expect(providers).toHaveLength(2);

          // Custom provider metadata
          const customInfo = providers.find(p => p.id === customId)!;
          expect(customInfo).toBeDefined();
          expect(customInfo.kind).toBe(customKind);
          expect(customInfo.capabilities).toEqual(customCaps);

          // Built-in provider metadata
          const builtinInfo = providers.find(p => p.id === builtinId)!;
          expect(builtinInfo).toBeDefined();
          expect(builtinInfo.kind).toBe('llm');
          expect(builtinInfo.capabilities).toEqual({
            streaming: true, tools: true, vision: true, jsonMode: true,
          });
          expect(builtinInfo.displayName).toBe(builtinDisplay);
          expect(builtinInfo.description).toBe(builtinDesc);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('property: custom provider created via defineProvider is usable for prompt() in multi-provider agent', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbProviderId,
        arbModels,
        fc.string({ minLength: 1, maxLength: 100 }),
        async (id, models, promptText) => {
          const completeFn = jest.fn<any>().mockResolvedValue({
            text: `echo: ${promptText}`,
            stopReason: 'end_turn',
          });

          const schema = z.object({
            token: z.string().min(1),
            models: z.array(z.string()).nonempty(),
          });

          const factory = defineProvider({
            id,
            schema,
            kind: 'llm',
            capabilities: { streaming: false, tools: false, vision: false, jsonMode: false },
            create: (opts) => ({
              id,
              models: Object.freeze(opts.models),
              complete: completeFn,
            }),
          });

          const provider = factory({ token: 'test', models });

          const agent = createMultiProviderAgent({
            id: 'prompt-test-agent',
            providers: [provider],
            defaultProviderId: provider.id,
          });

          await agent.onSessionCreate('s1');
          const result = await agent.prompt('s1', promptText);

          expect(completeFn).toHaveBeenCalledTimes(1);
          expect(result.text).toBe(`echo: ${promptText}`);

          // Verify the prompt text was passed through
          const [messages] = completeFn.mock.calls[0]!;
          const userMessage = (messages as ChatMessage[]).find(m => m.role === 'user');
          expect(userMessage?.content).toBe(promptText);
        },
      ),
      { numRuns: 50 },
    );
  });
});
