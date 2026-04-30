/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based and unit tests for ProviderRegistry.
 *
 * Tests cover:
 * - Property 1: Registry round-trip (register + get returns same instance)
 * - Property 2: Registry state consistency (list/has reflect registered state)
 * - Property 3: Registry duplicate rejection (duplicate id → CONFIG error)
 * - Property 4: Registry unknown id rejection (unknown id → UPSTREAM error)
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { ProviderRegistry } from '../../../src/provider/ProviderRegistry.js';
import { BridgeError } from '../../../src/errors/BridgeError.js';
import type { AIProvider, ChatMessage, RuntimeParams, AIProviderResult, ProviderKind, ProviderCapabilities } from '../../../src/provider/AIProvider.js';

// ── Helpers ─────────────────────────────────────────────────────

/** Create a mock AIProvider with the given id and models. */
function createMockProvider(id: string, models: string[] = ['model-1']): AIProvider {
  return {
    id,
    models: Object.freeze(models),
    async complete(
      _messages: ChatMessage[],
      _params: RuntimeParams,
      _signal?: AbortSignal,
    ): Promise<AIProviderResult> {
      return { text: 'mock response', stopReason: 'end_turn' };
    },
  };
}

// ── fast-check arbitraries ──────────────────────────────────────

/** Arbitrary for valid provider IDs (non-empty, alphanumeric + dashes). */
const arbProviderId = fc.stringMatching(/^[a-z][a-z0-9-]{0,29}$/);

/** Arbitrary for model identifier strings. */
const arbModelId = fc.stringMatching(/^[a-z][a-z0-9._-]{0,39}$/);

/** Arbitrary for a list of unique provider IDs. */
const arbUniqueProviderIds = fc.uniqueArray(arbProviderId, { minLength: 1, maxLength: 20 });

// ── Tests ───────────────────────────────────────────────────────

describe('ProviderRegistry', () => {
  // ── Property 1: Registry round-trip ─────────────────────────────

  describe('Property 1: Registry round-trip', () => {
    // Feature: multi-provider-agents, Property 1: Registry round-trip
    it('property: registering a provider and calling get(id) returns the same instance', () => {
      fc.assert(
        fc.property(
          arbProviderId,
          fc.array(arbModelId, { minLength: 1, maxLength: 5 }),
          (id, models) => {
            const registry = new ProviderRegistry();
            const provider = createMockProvider(id, models);

            registry.register(provider);
            const retrieved = registry.get(id);

            // Must be the exact same object reference
            return retrieved === provider;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should return the exact same provider instance that was registered', () => {
      const registry = new ProviderRegistry();
      const provider = createMockProvider('openai', ['gpt-4', 'gpt-3.5-turbo']);

      registry.register(provider);
      const retrieved = registry.get('openai');

      expect(retrieved).toBe(provider);
      expect(retrieved.id).toBe('openai');
      expect(retrieved.models).toEqual(['gpt-4', 'gpt-3.5-turbo']);
    });
  });

  // ── Property 2: Registry state consistency ──────────────────────

  describe('Property 2: Registry state consistency', () => {
    // Feature: multi-provider-agents, Property 2: Registry state consistency
    it('property: list() returns exactly N entries for N registered providers with matching ids and models', () => {
      fc.assert(
        fc.property(arbUniqueProviderIds, (ids) => {
          const registry = new ProviderRegistry();
          const providers = ids.map((id) => createMockProvider(id, [`${id}-model-1`, `${id}-model-2`]));

          for (const provider of providers) {
            registry.register(provider);
          }

          const listed = registry.list();

          // Exactly N entries
          if (listed.length !== ids.length) return false;

          // Each registered id appears in list with correct models
          for (const provider of providers) {
            const entry = listed.find((e) => e.id === provider.id);
            if (!entry) return false;
            if (entry.models !== provider.models) return false;
          }

          return true;
        }),
        { numRuns: 100 },
      );
    });

    // Feature: multi-provider-agents, Property 2: Registry state consistency
    it('property: has() returns true for registered ids and false for unregistered ids', () => {
      fc.assert(
        fc.property(
          arbUniqueProviderIds,
          arbProviderId,
          (registeredIds, unknownId) => {
            // Ensure unknownId is not in the registered set
            fc.pre(!registeredIds.includes(unknownId));

            const registry = new ProviderRegistry();
            for (const id of registeredIds) {
              registry.register(createMockProvider(id));
            }

            // has() returns true for all registered
            for (const id of registeredIds) {
              if (!registry.has(id)) return false;
            }

            // has() returns false for unregistered
            if (registry.has(unknownId)) return false;

            return true;
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should return an empty list when no providers are registered', () => {
      const registry = new ProviderRegistry();
      expect(registry.list()).toEqual([]);
    });

    it('should return correct list after multiple registrations', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('openai', ['gpt-4']));
      registry.register(createMockProvider('anthropic', ['claude-sonnet-4-20250514']));

      const listed = registry.list();
      expect(listed).toHaveLength(2);
      expect(listed).toContainEqual({ id: 'openai', models: expect.arrayContaining(['gpt-4']) });
      expect(listed).toContainEqual({ id: 'anthropic', models: expect.arrayContaining(['claude-sonnet-4-20250514']) });
    });
  });

  // ── Property 3: Registry duplicate rejection ────────────────────

  describe('Property 3: Registry duplicate rejection', () => {
    // Feature: multi-provider-agents, Property 3: Registry duplicate rejection
    it('property: registering two providers with the same id throws CONFIG BridgeError', () => {
      fc.assert(
        fc.property(arbProviderId, (id) => {
          const registry = new ProviderRegistry();
          const provider1 = createMockProvider(id, ['model-a']);
          const provider2 = createMockProvider(id, ['model-b']);

          registry.register(provider1);

          try {
            registry.register(provider2);
            return false; // Should have thrown
          } catch (err) {
            return (
              err instanceof BridgeError &&
              err.type === 'CONFIG' &&
              err.message.includes(id)
            );
          }
        }),
        { numRuns: 100 },
      );
    });

    it('should throw CONFIG BridgeError with duplicate id in message', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('openai'));

      expect(() => registry.register(createMockProvider('openai'))).toThrow(BridgeError);

      try {
        registry.register(createMockProvider('openai'));
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('openai');
      }
    });

    it('should not modify registry state when duplicate registration fails', () => {
      const registry = new ProviderRegistry();
      const original = createMockProvider('openai', ['gpt-4']);
      registry.register(original);

      try {
        registry.register(createMockProvider('openai', ['gpt-3.5-turbo']));
      } catch {
        // Expected
      }

      // Original provider is still there, unchanged
      expect(registry.get('openai')).toBe(original);
      expect(registry.list()).toHaveLength(1);
    });
  });

  // ── Property 4: Registry unknown id rejection ───────────────────

  describe('Property 4: Registry unknown id rejection', () => {
    // Feature: multi-provider-agents, Property 4: Registry unknown id rejection
    it('property: get() with unregistered id throws UPSTREAM BridgeError containing the id', () => {
      fc.assert(
        fc.property(
          arbUniqueProviderIds,
          arbProviderId,
          (registeredIds, unknownId) => {
            // Ensure unknownId is not in the registered set
            fc.pre(!registeredIds.includes(unknownId));

            const registry = new ProviderRegistry();
            for (const id of registeredIds) {
              registry.register(createMockProvider(id));
            }

            try {
              registry.get(unknownId);
              return false; // Should have thrown
            } catch (err) {
              return (
                err instanceof BridgeError &&
                err.type === 'UPSTREAM' &&
                err.message.includes(unknownId)
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should throw UPSTREAM BridgeError when getting non-existent provider', () => {
      const registry = new ProviderRegistry();

      expect(() => registry.get('nonexistent')).toThrow(BridgeError);

      try {
        registry.get('nonexistent');
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).message).toContain('nonexistent');
      }
    });

    it('should throw UPSTREAM even when other providers are registered', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('openai'));
      registry.register(createMockProvider('anthropic'));

      expect(() => registry.get('google-gemini')).toThrow(BridgeError);

      try {
        registry.get('google-gemini');
      } catch (err) {
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).message).toContain('google-gemini');
      }
    });
  });

  // ── Enriched ProviderInfo in list() ─────────────────────────────

  describe('Enriched ProviderInfo in list()', () => {
    /** Create a mock provider with enriched metadata fields. */
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
        async complete(
          _messages: ChatMessage[],
          _params: RuntimeParams,
          _signal?: AbortSignal,
        ): Promise<AIProviderResult> {
          return { text: 'mock', stopReason: 'end_turn' };
        },
      };
    }

    it('should include kind and capabilities when provider declares them', () => {
      const registry = new ProviderRegistry();
      const caps: ProviderCapabilities = { streaming: true, tools: true, vision: false, jsonMode: true };
      registry.register(createEnrichedProvider('openai', ['gpt-4o'], {
        kind: 'llm',
        capabilities: caps,
      }));

      const listed = registry.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.kind).toBe('llm');
      expect(listed[0]!.capabilities).toEqual(caps);
    });

    it('should omit kind and capabilities when provider does not declare them', () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('bare-provider', ['model-a']));

      const listed = registry.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe('bare-provider');
      expect(listed[0]!.models).toEqual(['model-a']);
      expect(listed[0]).not.toHaveProperty('kind');
      expect(listed[0]).not.toHaveProperty('capabilities');
      expect(listed[0]).not.toHaveProperty('displayName');
      expect(listed[0]).not.toHaveProperty('description');
    });

    it('should include displayName and description when provider declares them', () => {
      const registry = new ProviderRegistry();
      registry.register(createEnrichedProvider('anthropic', ['claude-sonnet-4-20250514'], {
        displayName: 'Anthropic',
        description: 'Claude models via official SDK',
      }));

      const listed = registry.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.displayName).toBe('Anthropic');
      expect(listed[0]!.description).toBe('Claude models via official SDK');
    });

    it('should omit description when provider declares an empty string', () => {
      const registry = new ProviderRegistry();
      registry.register(createEnrichedProvider('test', ['m1'], {
        displayName: 'Test',
        description: '',
      }));

      const listed = registry.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.displayName).toBe('Test');
      expect(listed[0]).not.toHaveProperty('description');
    });

    it('should omit capabilities when provider declares an empty capabilities object', () => {
      const registry = new ProviderRegistry();
      registry.register(createEnrichedProvider('test', ['m1'], {
        kind: 'llm',
        capabilities: {},
      }));

      const listed = registry.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.kind).toBe('llm');
      expect(listed[0]).not.toHaveProperty('capabilities');
    });

    it('should mix enriched and bare providers correctly', () => {
      const registry = new ProviderRegistry();
      registry.register(createEnrichedProvider('openai', ['gpt-4o'], {
        kind: 'llm',
        capabilities: { streaming: true, tools: true, vision: true, jsonMode: true },
        displayName: 'OpenAI',
        description: 'OpenAI GPT models',
      }));
      registry.register(createMockProvider('custom', ['custom-model']));

      const listed = registry.list();
      expect(listed).toHaveLength(2);

      const enriched = listed.find((p) => p.id === 'openai')!;
      expect(enriched.kind).toBe('llm');
      expect(enriched.capabilities).toEqual({ streaming: true, tools: true, vision: true, jsonMode: true });
      expect(enriched.displayName).toBe('OpenAI');
      expect(enriched.description).toBe('OpenAI GPT models');

      const bare = listed.find((p) => p.id === 'custom')!;
      expect(bare.id).toBe('custom');
      expect(bare.models).toEqual(['custom-model']);
      expect(bare).not.toHaveProperty('kind');
      expect(bare).not.toHaveProperty('capabilities');
      expect(bare).not.toHaveProperty('displayName');
      expect(bare).not.toHaveProperty('description');
    });

    it('should include all ProviderKind values correctly', () => {
      const registry = new ProviderRegistry();
      const kinds: ProviderKind[] = ['llm', 'embedding', 'reranker'];
      for (const kind of kinds) {
        registry.register(createEnrichedProvider(`provider-${kind}`, ['m1'], { kind }));
      }

      const listed = registry.list();
      expect(listed).toHaveLength(3);
      for (const kind of kinds) {
        const entry = listed.find((p) => p.id === `provider-${kind}`);
        expect(entry).toBeDefined();
        expect(entry!.kind).toBe(kind);
      }
    });
  });
});
