/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based and unit tests for createMultiProviderAgent.
 *
 * Property 5: createMultiProviderAgent — correct wiring (N providers → N registry entries).
 * Property 6: createMultiProviderAgent — configuration validation (empty, duplicates, invalid default).
 *
 * Unit tests cover:
 * - Successful creation with multiple providers
 * - Empty providers → BridgeError CONFIG
 * - Duplicate provider id → BridgeError CONFIG
 * - defaultProviderId not found → BridgeError CONFIG with available ids
 * - Returned agent is instance of MultiProviderAgent
 * - Optional fields (capabilities, systemPrompt, defaults) are passed through
 *
 * **Validates: Requirements 6.1–6.7**
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as fc from 'fast-check';
import { createMultiProviderAgent } from '../../../../src/provider/factories/createMultiProviderAgent.js';
import { MultiProviderAgent } from '../../../../src/agent/MultiProviderAgent.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import type { AIProvider, AIProviderResult, RuntimeParams } from '../../../../src/provider/AIProvider.js';

// ── Helpers ─────────────────────────────────────────────────────

/** Create a mock AIProvider with the given id and models. */
function createMockProvider(
  id: string,
  models: string[] = ['model-1'],
): AIProvider & { complete: jest.Mock<any> } {
  const defaultResult: AIProviderResult = {
    text: `response from ${id}`,
    stopReason: 'end_turn',
  };
  return {
    id,
    models: Object.freeze(models),
    complete: jest.fn<any>().mockResolvedValue(defaultResult),
  };
}

// ── fast-check arbitraries ──────────────────────────────────────

/** Arbitrary for valid provider IDs. */
const arbProviderId = fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/);

/** Arbitrary for a unique set of N provider IDs (2–10). */
const arbUniqueProviderIds = fc.uniqueArray(arbProviderId, { minLength: 2, maxLength: 10 });

/** Arbitrary for a single unique provider ID not in a given set. */
function arbProviderIdNotIn(ids: string[]): fc.Arbitrary<string> {
  return arbProviderId.filter(id => !ids.includes(id));
}

// ── Property 5: createMultiProviderAgent — correct wiring ───────

// Feature: provider-factory-api, Property 5: createMultiProviderAgent — correct wiring
describe('Property 5: createMultiProviderAgent — correct wiring', () => {
  it('property: for N providers with unique ids, getProviderRegistry().list() contains exactly N entries', () => {
    fc.assert(
      fc.property(
        arbUniqueProviderIds,
        (ids) => {
          const providers = ids.map(id => createMockProvider(id));
          const defaultProviderId = ids[0]!;

          const agent = createMultiProviderAgent({
            id: 'test-agent',
            providers,
            defaultProviderId,
          });

          const registryList = agent.getProviderRegistry().list();

          // Registry must contain exactly N entries
          expect(registryList).toHaveLength(ids.length);

          // Each provider id must appear in the registry
          const registryIds = new Set(registryList.map(p => p.id));
          for (const id of ids) {
            expect(registryIds.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: returned agent has the correct id', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbUniqueProviderIds,
        (agentId, providerIds) => {
          const providers = providerIds.map(id => createMockProvider(id));

          const agent = createMultiProviderAgent({
            id: agentId,
            providers,
            defaultProviderId: providerIds[0]!,
          });

          expect(agent.id).toBe(agentId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: returned agent is an instance of MultiProviderAgent', () => {
    fc.assert(
      fc.property(
        arbUniqueProviderIds,
        (ids) => {
          const providers = ids.map(id => createMockProvider(id));

          const agent = createMultiProviderAgent({
            id: 'test-agent',
            providers,
            defaultProviderId: ids[0]!,
          });

          expect(agent).toBeInstanceOf(MultiProviderAgent);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: each provider in registry has correct models', () => {
    fc.assert(
      fc.property(
        arbUniqueProviderIds,
        fc.array(
          fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 3 }),
          { minLength: 2, maxLength: 10 },
        ),
        (ids, modelArrays) => {
          // Align lengths
          const count = Math.min(ids.length, modelArrays.length);
          const usedIds = ids.slice(0, count);
          const usedModels = modelArrays.slice(0, count);

          const providers = usedIds.map((id, i) => createMockProvider(id, usedModels[i]!));

          const agent = createMultiProviderAgent({
            id: 'test-agent',
            providers,
            defaultProviderId: usedIds[0]!,
          });

          const registryList = agent.getProviderRegistry().list();

          for (let i = 0; i < count; i++) {
            const entry = registryList.find(p => p.id === usedIds[i]);
            expect(entry).toBeDefined();
            expect([...entry!.models]).toEqual(usedModels[i]);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── Property 6: createMultiProviderAgent — validation ───────────

// Feature: provider-factory-api, Property 6: createMultiProviderAgent — configuration validation
describe('Property 6: createMultiProviderAgent — configuration validation', () => {
  it('property: empty providers array throws BridgeError CONFIG', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbProviderId,
        (agentId, defaultProviderId) => {
          try {
            createMultiProviderAgent({
              id: agentId,
              providers: [],
              defaultProviderId,
            });
            throw new Error('Expected BridgeError but succeeded');
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).type).toBe('CONFIG');
            expect((err as BridgeError).message).toContain('at least one provider');
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('property: duplicate provider ids throw BridgeError CONFIG containing the duplicate id', () => {
    fc.assert(
      fc.property(
        arbProviderId,
        arbProviderId,
        (agentId, duplicateId) => {
          const providers = [
            createMockProvider(duplicateId),
            createMockProvider(duplicateId),
          ];

          try {
            createMultiProviderAgent({
              id: agentId,
              providers,
              defaultProviderId: duplicateId,
            });
            throw new Error('Expected BridgeError but succeeded');
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).type).toBe('CONFIG');
            expect((err as BridgeError).message).toContain(duplicateId);
            expect((err as BridgeError).message).toContain('Duplicate');
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('property: defaultProviderId not in providers throws BridgeError CONFIG with available ids', () => {
    fc.assert(
      fc.property(
        arbUniqueProviderIds,
        (ids) => {
          // Generate an id that is NOT in the set
          const invalidDefault = ids.join('') + '-invalid';
          const providers = ids.map(id => createMockProvider(id));

          try {
            createMultiProviderAgent({
              id: 'test-agent',
              providers,
              defaultProviderId: invalidDefault,
            });
            throw new Error('Expected BridgeError but succeeded');
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).type).toBe('CONFIG');
            expect((err as BridgeError).message).toContain(invalidDefault);
            // Error message should list available provider ids
            for (const id of ids) {
              expect((err as BridgeError).message).toContain(id);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ── Unit tests ──────────────────────────────────────────────────

describe('createMultiProviderAgent', () => {
  describe('successful creation', () => {
    it('should create agent with multiple providers', () => {
      const openai = createMockProvider('openai', ['gpt-4o']);
      const anthropic = createMockProvider('anthropic', ['claude-3']);

      const agent = createMultiProviderAgent({
        id: 'my-agent',
        providers: [openai, anthropic],
        defaultProviderId: 'openai',
      });

      expect(agent).toBeInstanceOf(MultiProviderAgent);
      expect(agent.id).toBe('my-agent');

      const registry = agent.getProviderRegistry();
      expect(registry.list()).toHaveLength(2);
      expect(registry.has('openai')).toBe(true);
      expect(registry.has('anthropic')).toBe(true);
    });

    it('should create agent with a single provider', () => {
      const openai = createMockProvider('openai', ['gpt-4o']);

      const agent = createMultiProviderAgent({
        id: 'single-agent',
        providers: [openai],
        defaultProviderId: 'openai',
      });

      expect(agent).toBeInstanceOf(MultiProviderAgent);
      expect(agent.getProviderRegistry().list()).toHaveLength(1);
    });

    it('should pass capabilities to the agent', () => {
      const openai = createMockProvider('openai');

      const agent = createMultiProviderAgent({
        id: 'capable-agent',
        providers: [openai],
        defaultProviderId: 'openai',
        capabilities: ['chat', 'code-generation'],
      });

      expect(agent.capabilities).toEqual(['chat', 'code-generation']);
    });

    it('should pass systemPrompt and defaults through to the agent', async () => {
      const openai = createMockProvider('openai');

      const agent = createMultiProviderAgent({
        id: 'configured-agent',
        providers: [openai],
        defaultProviderId: 'openai',
        systemPrompt: 'You are a helpful assistant.',
        defaults: { temperature: 0.7, maxTokens: 1000 },
      });

      // Verify by creating a session and prompting — the system prompt
      // and defaults should be passed to the provider
      await agent.onSessionCreate('s1');
      await agent.prompt('s1', 'hello');

      expect(openai.complete).toHaveBeenCalledTimes(1);
      const [messages, params] = openai.complete.mock.calls[0]!;
      // System prompt should be first message
      expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
      // Defaults should be merged into params
      expect((params as RuntimeParams).temperature).toBe(0.7);
      expect((params as RuntimeParams).maxTokens).toBe(1000);
    });

    it('should use the default provider for sessions without override', async () => {
      const openai = createMockProvider('openai');
      const anthropic = createMockProvider('anthropic');

      const agent = createMultiProviderAgent({
        id: 'multi-agent',
        providers: [openai, anthropic],
        defaultProviderId: 'openai',
      });

      await agent.onSessionCreate('s1');
      await agent.prompt('s1', 'hello');

      expect(openai.complete).toHaveBeenCalledTimes(1);
      expect(anthropic.complete).not.toHaveBeenCalled();
    });
  });

  describe('validation errors', () => {
    it('should throw BridgeError CONFIG for empty providers array', () => {
      expect(() => createMultiProviderAgent({
        id: 'empty-agent',
        providers: [],
        defaultProviderId: 'openai',
      })).toThrow(BridgeError);

      try {
        createMultiProviderAgent({
          id: 'empty-agent',
          providers: [],
          defaultProviderId: 'openai',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('at least one provider');
      }
    });

    it('should throw BridgeError CONFIG for duplicate provider id', () => {
      const openai1 = createMockProvider('openai', ['gpt-4o']);
      const openai2 = createMockProvider('openai', ['gpt-3.5-turbo']);

      expect(() => createMultiProviderAgent({
        id: 'dup-agent',
        providers: [openai1, openai2],
        defaultProviderId: 'openai',
      })).toThrow(BridgeError);

      try {
        createMultiProviderAgent({
          id: 'dup-agent',
          providers: [openai1, openai2],
          defaultProviderId: 'openai',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('Duplicate');
        expect((err as BridgeError).message).toContain('openai');
      }
    });

    it('should throw BridgeError CONFIG when defaultProviderId not found, listing available ids', () => {
      const openai = createMockProvider('openai');
      const anthropic = createMockProvider('anthropic');

      expect(() => createMultiProviderAgent({
        id: 'bad-default-agent',
        providers: [openai, anthropic],
        defaultProviderId: 'nonexistent',
      })).toThrow(BridgeError);

      try {
        createMultiProviderAgent({
          id: 'bad-default-agent',
          providers: [openai, anthropic],
          defaultProviderId: 'nonexistent',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('nonexistent');
        expect((err as BridgeError).message).toContain('openai');
        expect((err as BridgeError).message).toContain('anthropic');
      }
    });

    it('should detect duplicate at position > 1 (not just adjacent)', () => {
      const a = createMockProvider('alpha');
      const b = createMockProvider('beta');
      const aDup = createMockProvider('alpha', ['other-model']);

      expect(() => createMultiProviderAgent({
        id: 'dup-agent',
        providers: [a, b, aDup],
        defaultProviderId: 'alpha',
      })).toThrow(BridgeError);

      try {
        createMultiProviderAgent({
          id: 'dup-agent',
          providers: [a, b, aDup],
          defaultProviderId: 'alpha',
        });
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('alpha');
      }
    });
  });

  describe('returned agent type', () => {
    it('should return an instance of MultiProviderAgent', () => {
      const openai = createMockProvider('openai');

      const agent = createMultiProviderAgent({
        id: 'typed-agent',
        providers: [openai],
        defaultProviderId: 'openai',
      });

      expect(agent).toBeInstanceOf(MultiProviderAgent);
    });

    it('should return an agent that implements AgentHandler (has prompt, onSessionCreate, onSessionClose)', () => {
      const openai = createMockProvider('openai');

      const agent = createMultiProviderAgent({
        id: 'handler-agent',
        providers: [openai],
        defaultProviderId: 'openai',
      });

      expect(typeof agent.prompt).toBe('function');
      expect(typeof agent.onSessionCreate).toBe('function');
      expect(typeof agent.onSessionClose).toBe('function');
    });
  });
});
