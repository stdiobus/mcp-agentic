/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based and unit tests for agents_discover provider enrichment.
 *
 * Tests cover:
 * - Property 17: Discovery includes provider information
 *
 * Validates: Requirements 9.1, 9.2, 9.4
 */

import { describe, expect, it, jest } from '@jest/globals';
import * as fc from 'fast-check';
import { handleCombinedDiscover } from '../../../../src/mcp/tools/agents.js';
import { InProcessExecutor } from '../../../../src/executor/InProcessExecutor.js';
import { ProviderRegistry } from '../../../../src/provider/ProviderRegistry.js';
import { MultiProviderAgent } from '../../../../src/agent/MultiProviderAgent.js';
import type {
  AIProvider,
  AIProviderResult,
  ProviderCapabilities,
  ProviderKind,
} from '../../../../src/provider/AIProvider.js';
import type { AgentInfo } from '../../../../src/executor/types.js';
import { createMockExecutor } from './_mockExecutor.js';

// ── Helpers ─────────────────────────────────────────────────────

/** Create a mock AIProvider with the given id and models. */
function createMockProvider(
  id: string,
  models: string[] = ['model-1'],
): AIProvider {
  const result: AIProviderResult = { text: 'response', stopReason: 'end_turn' };
  return {
    id,
    models: Object.freeze(models),
    complete: jest.fn<any>().mockResolvedValue(result),
  };
}

/** Create a mock AIProvider with enriched metadata fields. */
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
  const result: AIProviderResult = { text: 'response', stopReason: 'end_turn' };
  return {
    id,
    models: Object.freeze(models),
    ...(extra.kind !== undefined ? { kind: extra.kind } : {}),
    ...(extra.capabilities !== undefined ? { capabilities: extra.capabilities } : {}),
    ...(extra.displayName !== undefined ? { displayName: extra.displayName } : {}),
    ...(extra.description !== undefined ? { description: extra.description } : {}),
    complete: jest.fn<any>().mockResolvedValue(result),
  };
}

/** Create a registry with the given providers. */
function createRegistry(...providers: AIProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) {
    registry.register(provider);
  }
  return registry;
}

// ── fast-check arbitraries ──────────────────────────────────────

/** Arbitrary for valid provider IDs. */
const arbProviderId = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/);

/** Arbitrary for model name strings. */
const arbModelName = fc.stringMatching(/^[a-z][a-z0-9._-]{0,29}$/);

/** Arbitrary for a provider spec (id + models). */
const arbProviderSpec = fc.tuple(
  arbProviderId,
  fc.array(arbModelName, { minLength: 1, maxLength: 5 }),
);

/** Arbitrary for a list of providers with unique IDs. */
const arbProviderSpecs = fc.array(arbProviderSpec, { minLength: 1, maxLength: 5 })
  .map((specs) => {
    // Deduplicate by provider id
    const seen = new Set<string>();
    return specs.filter(([id]) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  })
  .filter((specs) => specs.length > 0);

// ── Property 17: Discovery includes provider information ────────

describe('agents_discover — Provider enrichment', () => {
  describe('Property 17: Discovery includes provider information', () => {
    // Feature: multi-provider-agents, Property 17: Discovery includes provider information
    it('property: agents with ProviderRegistry include providers field with correct id and models', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbProviderSpecs,
          async (providerSpecs) => {
            // Create providers from specs
            const providers = providerSpecs.map(([id, models]) => createMockProvider(id, models));
            const registry = createRegistry(...providers);

            // Create a MultiProviderAgent with the registry
            const agent = new MultiProviderAgent({
              id: 'multi-agent',
              defaultProviderId: providers[0]!.id,
              registry,
              capabilities: ['chat'],
            });

            // Set up InProcessExecutor with the agent
            const executor = new InProcessExecutor({ silent: true });
            executor.register(agent);
            await executor.start();

            try {
              const result = await handleCombinedDiscover(executor, undefined, {});
              const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

              // Should have exactly one agent
              if (parsed.agents.length !== 1) return false;

              const agentInfo = parsed.agents[0]!;

              // providers field must be present
              if (!agentInfo.providers) return false;

              // Must have exactly N providers matching the registry
              if (agentInfo.providers.length !== providerSpecs.length) return false;

              // Each provider must have correct id and models
              for (const [expectedId, expectedModels] of providerSpecs) {
                const found = agentInfo.providers.find((p) => p.id === expectedId);
                if (!found) return false;
                // Models must match (as arrays)
                if (found.models.length !== expectedModels.length) return false;
                for (let i = 0; i < expectedModels.length; i++) {
                  if (found.models[i] !== expectedModels[i]) return false;
                }
              }

              return true;
            } finally {
              await executor.close();
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    // Feature: multi-provider-agents, Property 17: Discovery includes provider information
    it('property: provider information reflects current registry state at discovery time', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbProviderSpecs,
          arbProviderSpec,
          async (initialSpecs, additionalSpec) => {
            // Ensure additional provider has a unique id
            const existingIds = new Set(initialSpecs.map(([id]) => id));
            if (existingIds.has(additionalSpec[0])) return true; // skip this case

            // Create initial providers
            const initialProviders = initialSpecs.map(([id, models]) => createMockProvider(id, models));
            const registry = createRegistry(...initialProviders);

            const agent = new MultiProviderAgent({
              id: 'multi-agent',
              defaultProviderId: initialProviders[0]!.id,
              registry,
              capabilities: ['chat'],
            });

            const executor = new InProcessExecutor({ silent: true });
            executor.register(agent);
            await executor.start();

            try {
              // First discovery — should have initial providers
              const result1 = await handleCombinedDiscover(executor, undefined, {});
              const parsed1 = JSON.parse(result1.content[0]!.text) as { agents: AgentInfo[] };
              if (parsed1.agents[0]!.providers!.length !== initialSpecs.length) return false;

              // Add a new provider to the registry
              const newProvider = createMockProvider(additionalSpec[0], additionalSpec[1]);
              registry.register(newProvider);

              // Second discovery — should reflect the updated registry
              const result2 = await handleCombinedDiscover(executor, undefined, {});
              const parsed2 = JSON.parse(result2.content[0]!.text) as { agents: AgentInfo[] };
              if (parsed2.agents[0]!.providers!.length !== initialSpecs.length + 1) return false;

              // New provider should be present
              const found = parsed2.agents[0]!.providers!.find((p) => p.id === additionalSpec[0]);
              if (!found) return false;

              return true;
            } finally {
              await executor.close();
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── Unit tests ──────────────────────────────────────────────────

  describe('Unit: provider enrichment in handleCombinedDiscover', () => {
    it('should include providers field for agent with ProviderRegistry', async () => {
      const openai = createMockProvider('openai', ['gpt-4', 'gpt-3.5-turbo']);
      const anthropic = createMockProvider('anthropic', ['claude-sonnet-4-20250514']);
      const registry = createRegistry(openai, anthropic);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'openai',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      const result = await handleCombinedDiscover(executor, undefined, {});
      const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0]!.providers).toBeDefined();
      expect(parsed.agents[0]!.providers).toHaveLength(2);
      expect(parsed.agents[0]!.providers).toEqual(
        expect.arrayContaining([
          { id: 'openai', models: ['gpt-4', 'gpt-3.5-turbo'] },
          { id: 'anthropic', models: ['claude-sonnet-4-20250514'] },
        ]),
      );

      await executor.close();
    });

    it('should omit providers field for agent without getProviderRegistry', async () => {
      // A plain AgentHandler without getProviderRegistry
      const simpleAgent = {
        id: 'simple-agent',
        capabilities: ['chat'],
        async prompt() {
          return { text: 'hello', stopReason: 'end_turn' as const };
        },
      };

      const executor = new InProcessExecutor({ silent: true });
      executor.register(simpleAgent);
      await executor.start();

      const result = await handleCombinedDiscover(executor, undefined, {});
      const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0]!.providers).toBeUndefined();

      await executor.close();
    });

    it('should omit providers field when executor does not support getAgent (e.g., worker executor)', async () => {
      // Mock executor without getAgent method (like WorkerExecutor)
      const workerExecutor = createMockExecutor({
        discover: jest.fn<any>().mockResolvedValue([
          { id: 'worker-agent', capabilities: ['code'], status: 'ready' },
        ]),
      });

      const result = await handleCombinedDiscover(
        createMockExecutor({ discover: jest.fn<any>().mockResolvedValue([]) }),
        workerExecutor,
        {},
      );
      const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0]!.id).toBe('worker-agent');
      expect(parsed.agents[0]!.providers).toBeUndefined();
    });

    it('should handle mixed agents: some with providers, some without', async () => {
      const openai = createMockProvider('openai', ['gpt-4']);
      const registry = createRegistry(openai);

      const multiAgent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'openai',
        registry,
        capabilities: ['chat'],
      });

      const simpleAgent = {
        id: 'simple-agent',
        capabilities: ['code'],
        async prompt() {
          return { text: 'hello', stopReason: 'end_turn' as const };
        },
      };

      const executor = new InProcessExecutor({ silent: true });
      executor.register(multiAgent);
      executor.register(simpleAgent);
      await executor.start();

      const result = await handleCombinedDiscover(executor, undefined, {});
      const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

      expect(parsed.agents).toHaveLength(2);

      const multi = parsed.agents.find((a) => a.id === 'multi-agent');
      const simple = parsed.agents.find((a) => a.id === 'simple-agent');

      expect(multi!.providers).toEqual([{ id: 'openai', models: ['gpt-4'] }]);
      expect(simple!.providers).toBeUndefined();

      await executor.close();
    });

    it('should omit providers field when registry is empty', async () => {
      const registry = new ProviderRegistry();
      // We need at least one provider for the agent constructor to validate
      const dummyProvider = createMockProvider('dummy', ['m1']);
      registry.register(dummyProvider);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'dummy',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      // The registry has one provider, so providers should be included
      const result = await handleCombinedDiscover(executor, undefined, {});
      const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

      expect(parsed.agents[0]!.providers).toEqual([{ id: 'dummy', models: ['m1'] }]);

      await executor.close();
    });
  });

  // ── Enriched provider info in agents_discover (Requirements 7.1–7.5) ──

  describe('Unit: enriched provider info in agents_discover', () => {
    it('should include kind and capabilities for providers that declare them', async () => {
      const caps: ProviderCapabilities = { streaming: true, tools: true, vision: true, jsonMode: true };
      const provider = createEnrichedProvider('openai', ['gpt-4o'], {
        kind: 'llm',
        capabilities: caps,
        displayName: 'OpenAI',
        description: 'OpenAI GPT models via official SDK',
      });
      const registry = createRegistry(provider);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'openai',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      try {
        const result = await handleCombinedDiscover(executor, undefined, {});
        const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

        expect(parsed.agents).toHaveLength(1);
        const providers = parsed.agents[0]!.providers!;
        expect(providers).toHaveLength(1);
        expect(providers[0]!.kind).toBe('llm');
        expect(providers[0]!.capabilities).toEqual(caps);
        expect(providers[0]!.displayName).toBe('OpenAI');
        expect(providers[0]!.description).toBe('OpenAI GPT models via official SDK');
      } finally {
        await executor.close();
      }
    });

    it('should omit kind when provider does not declare it (default behavior)', async () => {
      // Provider without kind — ProviderRegistry.list() omits the field
      const provider = createMockProvider('custom', ['custom-model']);
      const registry = createRegistry(provider);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'custom',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      try {
        const result = await handleCombinedDiscover(executor, undefined, {});
        const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

        const providers = parsed.agents[0]!.providers!;
        expect(providers).toHaveLength(1);
        expect(providers[0]!.id).toBe('custom');
        expect(providers[0]).not.toHaveProperty('kind');
      } finally {
        await executor.close();
      }
    });

    it('should omit capabilities when provider does not declare them', async () => {
      // Provider without capabilities — ProviderRegistry.list() omits the field
      const provider = createMockProvider('bare', ['model-a']);
      const registry = createRegistry(provider);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'bare',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      try {
        const result = await handleCombinedDiscover(executor, undefined, {});
        const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

        const providers = parsed.agents[0]!.providers!;
        expect(providers).toHaveLength(1);
        expect(providers[0]).not.toHaveProperty('capabilities');
        expect(providers[0]).not.toHaveProperty('kind');
        expect(providers[0]).not.toHaveProperty('displayName');
        expect(providers[0]).not.toHaveProperty('description');
      } finally {
        await executor.close();
      }
    });

    it('should omit capabilities when provider declares empty capabilities object', async () => {
      const provider = createEnrichedProvider('test', ['m1'], {
        kind: 'llm',
        capabilities: {},
      });
      const registry = createRegistry(provider);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'test',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      try {
        const result = await handleCombinedDiscover(executor, undefined, {});
        const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

        const providers = parsed.agents[0]!.providers!;
        expect(providers[0]!.kind).toBe('llm');
        expect(providers[0]).not.toHaveProperty('capabilities');
      } finally {
        await executor.close();
      }
    });

    it('should mix enriched and bare providers in the same agent', async () => {
      const enriched = createEnrichedProvider('openai', ['gpt-4o'], {
        kind: 'llm',
        capabilities: { streaming: true, tools: true, vision: true, jsonMode: true },
        displayName: 'OpenAI',
        description: 'OpenAI GPT models',
      });
      const bare = createMockProvider('custom', ['custom-model']);
      const registry = createRegistry(enriched, bare);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'openai',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      try {
        const result = await handleCombinedDiscover(executor, undefined, {});
        const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

        const providers = parsed.agents[0]!.providers!;
        expect(providers).toHaveLength(2);

        const openaiInfo = providers.find((p) => p.id === 'openai')!;
        expect(openaiInfo.kind).toBe('llm');
        expect(openaiInfo.capabilities).toEqual({ streaming: true, tools: true, vision: true, jsonMode: true });
        expect(openaiInfo.displayName).toBe('OpenAI');
        expect(openaiInfo.description).toBe('OpenAI GPT models');

        const customInfo = providers.find((p) => p.id === 'custom')!;
        expect(customInfo.id).toBe('custom');
        expect(customInfo.models).toEqual(['custom-model']);
        expect(customInfo).not.toHaveProperty('kind');
        expect(customInfo).not.toHaveProperty('capabilities');
        expect(customInfo).not.toHaveProperty('displayName');
        expect(customInfo).not.toHaveProperty('description');
      } finally {
        await executor.close();
      }
    });

    it('should include displayName and description when provider declares them', async () => {
      const provider = createEnrichedProvider('anthropic', ['claude-sonnet-4-20250514'], {
        displayName: 'Anthropic',
        description: 'Claude models via official SDK',
      });
      const registry = createRegistry(provider);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'anthropic',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      try {
        const result = await handleCombinedDiscover(executor, undefined, {});
        const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

        const providers = parsed.agents[0]!.providers!;
        expect(providers[0]!.displayName).toBe('Anthropic');
        expect(providers[0]!.description).toBe('Claude models via official SDK');
      } finally {
        await executor.close();
      }
    });

    it('should omit description when provider declares empty string', async () => {
      const provider = createEnrichedProvider('test', ['m1'], {
        displayName: 'Test',
        description: '',
      });
      const registry = createRegistry(provider);

      const agent = new MultiProviderAgent({
        id: 'multi-agent',
        defaultProviderId: 'test',
        registry,
        capabilities: ['chat'],
      });

      const executor = new InProcessExecutor({ silent: true });
      executor.register(agent);
      await executor.start();

      try {
        const result = await handleCombinedDiscover(executor, undefined, {});
        const parsed = JSON.parse(result.content[0]!.text) as { agents: AgentInfo[] };

        const providers = parsed.agents[0]!.providers!;
        expect(providers[0]!.displayName).toBe('Test');
        expect(providers[0]).not.toHaveProperty('description');
      } finally {
        await executor.close();
      }
    });
  });
});
