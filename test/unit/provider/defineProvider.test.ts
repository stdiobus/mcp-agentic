/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit and property-based tests for defineProvider.
 *
 * Tests cover:
 * - Property 1: defineProvider returns callable factory with correct metadata
 * - Property 2: Zod validation of options before calling create
 * - Property 9: Validation of create() result in defineProvider
 * - Unit tests for full configuration, defaults, Zod rejection, create validation,
 *   and callable factory returning AIProvider with kind and capabilities
 *
 * **Validates: Requirements 1.1–1.10, 12.4, 12.5**
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as fc from 'fast-check';
import { z } from 'zod';
import { defineProvider } from '../../../src/provider/defineProvider.js';
import { BridgeError } from '../../../src/errors/BridgeError.js';
import type { AIProvider, ProviderKind, ProviderCapabilities } from '../../../src/provider/AIProvider.js';

// ── Helpers ─────────────────────────────────────────────────────

/** Minimal valid AIProvider for testing. */
function createMockProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    id: 'test-provider',
    models: ['model-a'],
    complete: jest.fn<any>().mockResolvedValue({ text: 'ok', stopReason: 'end_turn' }),
    ...overrides,
  };
}

/** Simple Zod schema for testing. */
const testSchema = z.object({
  key: z.string().min(1, 'key must be non-empty'),
});

// ── Property 1: defineProvider metadata defaults ────────────────

// Feature: provider-factory-api, Property 1: defineProvider returns callable factory with correct metadata
describe('Property 1: defineProvider returns callable factory with correct metadata', () => {
  it('should attach correct metadata for arbitrary configurations', () => {
    const validKinds: ProviderKind[] = ['llm', 'embedding', 'reranker'];

    fc.assert(
      fc.property(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          kindIndex: fc.integer({ min: 0, max: validKinds.length - 1 }),
          hasKind: fc.boolean(),
          hasDisplayName: fc.boolean(),
          hasDescription: fc.boolean(),
          displayNameSuffix: fc.string({ minLength: 0, maxLength: 20 }),
          descriptionSuffix: fc.string({ minLength: 0, maxLength: 50 }),
        }),
        ({ id, kindIndex, hasKind, hasDisplayName, hasDescription, displayNameSuffix, descriptionSuffix }) => {
          const chosenKind = validKinds[kindIndex]!;
          const chosenDisplayName = `Display-${displayNameSuffix}`;
          const chosenDescription = `Desc-${descriptionSuffix}`;

          const config: any = {
            id,
            schema: testSchema,
            create: () => createMockProvider({ id }),
          };
          if (hasKind) config.kind = chosenKind;
          if (hasDisplayName) config.displayName = chosenDisplayName;
          if (hasDescription) config.description = chosenDescription;

          const factory = defineProvider(config);

          // Factory is callable
          expect(typeof factory).toBe('function');

          // Static metadata matches provided values or defaults
          expect(factory.id).toBe(id);
          expect(factory.kind).toBe(hasKind ? chosenKind : 'llm');
          expect(factory.displayName).toBe(hasDisplayName ? chosenDisplayName : id);
          expect(factory.description).toBe(hasDescription ? chosenDescription : '');
          expect(factory.schema).toBe(testSchema);
          expect(factory.capabilities).toEqual({}); // default when not provided
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should attach provided capabilities to factory metadata', () => {
    fc.assert(
      fc.property(
        fc.record({
          streaming: fc.boolean(),
          tools: fc.boolean(),
          vision: fc.boolean(),
          jsonMode: fc.boolean(),
        }),
        (caps) => {
          const factory = defineProvider({
            id: 'cap-test',
            schema: testSchema,
            create: () => createMockProvider({ id: 'cap-test' }),
            capabilities: caps,
          });

          expect(factory.capabilities).toEqual(caps);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 2: Zod validation before create ────────────────────

// Feature: provider-factory-api, Property 2: Zod validation of options before calling create
describe('Property 2: Zod validation of options before calling create', () => {
  it('should throw BridgeError CONFIG and NOT call create for invalid options', () => {
    const strictSchema = z.object({
      apiKey: z.string().min(1),
      count: z.number().int().positive(),
    });

    fc.assert(
      fc.property(
        fc.oneof(
          // Missing apiKey entirely
          fc.record({ count: fc.integer({ min: 1 }) }).map(r => r as Record<string, unknown>),
          // Empty apiKey
          fc.record({ apiKey: fc.constant(''), count: fc.integer({ min: 1 }) }).map(r => r as Record<string, unknown>),
          // Invalid count (non-positive)
          fc.record({ apiKey: fc.string({ minLength: 1 }), count: fc.integer({ max: 0 }) }).map(r => r as Record<string, unknown>),
          // Wrong type for count
          fc.record({ apiKey: fc.string({ minLength: 1 }), count: fc.string() }).map(r => r as Record<string, unknown>),
        ),
        (invalidOptions) => {
          const createFn = jest.fn<any>().mockReturnValue(createMockProvider());

          const factory = defineProvider({
            id: 'validation-test',
            schema: strictSchema,
            create: createFn,
          });

          expect(() => factory(invalidOptions as any)).toThrow(BridgeError);

          try {
            factory(invalidOptions as any);
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).type).toBe('CONFIG');
            expect((err as BridgeError).message).toContain('Invalid options for provider "validation-test"');
          }

          // create must NOT have been called
          expect(createFn).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 9: Validation of create() result ───────────────────

// Feature: provider-factory-api, Property 9: Validation of create() result in defineProvider
describe('Property 9: Validation of create() result in defineProvider', () => {
  it('should throw BridgeError CONFIG when create() returns object without complete()', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
        (providerId) => {
          const factory = defineProvider({
            id: providerId,
            schema: testSchema,
            create: () => ({ id: providerId, models: ['m1'] } as any),
          });

          expect(() => factory({ key: 'valid' })).toThrow(BridgeError);

          try {
            factory({ key: 'valid' });
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).type).toBe('CONFIG');
            expect((err as BridgeError).message).toContain('complete()');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should throw BridgeError CONFIG when create() returns object without id', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
        (providerId) => {
          const factory = defineProvider({
            id: providerId,
            schema: testSchema,
            create: () => ({
              models: ['m1'],
              complete: async () => ({ text: '', stopReason: 'end_turn' }),
            } as any),
          });

          expect(() => factory({ key: 'valid' })).toThrow(BridgeError);

          try {
            factory({ key: 'valid' });
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).type).toBe('CONFIG');
            expect((err as BridgeError).message).toContain('id');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should throw BridgeError CONFIG when create() returns object without models', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
        (providerId) => {
          const factory = defineProvider({
            id: providerId,
            schema: testSchema,
            create: () => ({
              id: providerId,
              complete: async () => ({ text: '', stopReason: 'end_turn' }),
            } as any),
          });

          expect(() => factory({ key: 'valid' })).toThrow(BridgeError);

          try {
            factory({ key: 'valid' });
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).type).toBe('CONFIG');
            expect((err as BridgeError).message).toContain('models');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should throw BridgeError CONFIG when create() returns null/undefined', () => {
    for (const badReturn of [null, undefined]) {
      const factory = defineProvider({
        id: 'null-test',
        schema: testSchema,
        create: () => badReturn as any,
      });

      expect(() => factory({ key: 'valid' })).toThrow(BridgeError);

      try {
        factory({ key: 'valid' });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    }
  });
});

// ── Unit tests for defineProvider ────────────────────────────────

describe('defineProvider — unit tests', () => {
  describe('successful factory creation with full configuration', () => {
    it('should create a factory with all config fields', () => {
      const capabilities: ProviderCapabilities = {
        streaming: true,
        tools: true,
        vision: false,
        jsonMode: true,
      };

      const factory = defineProvider({
        id: 'full-config',
        schema: testSchema,
        create: (opts) => createMockProvider({ id: 'full-config' }),
        kind: 'llm',
        displayName: 'Full Config Provider',
        description: 'A fully configured test provider',
        capabilities,
      });

      expect(factory.id).toBe('full-config');
      expect(factory.kind).toBe('llm');
      expect(factory.displayName).toBe('Full Config Provider');
      expect(factory.description).toBe('A fully configured test provider');
      expect(factory.capabilities).toEqual(capabilities);
      expect(factory.schema).toBeDefined();
    });

    it('should return a callable factory that produces AIProvider', () => {
      const factory = defineProvider({
        id: 'callable-test',
        schema: testSchema,
        create: (opts) => createMockProvider({ id: 'callable-test' }),
      });

      const provider = factory({ key: 'test-key' });

      expect(provider.id).toBe('callable-test');
      expect(provider.models).toEqual(['model-a']);
      expect(typeof provider.complete).toBe('function');
    });
  });

  describe('default values for optional fields', () => {
    it('should default kind to "llm"', () => {
      const factory = defineProvider({
        id: 'default-kind',
        schema: testSchema,
        create: () => createMockProvider({ id: 'default-kind' }),
      });

      expect(factory.kind).toBe('llm');
    });

    it('should default capabilities to empty object', () => {
      const factory = defineProvider({
        id: 'default-caps',
        schema: testSchema,
        create: () => createMockProvider({ id: 'default-caps' }),
      });

      expect(factory.capabilities).toEqual({});
    });

    it('should default displayName to id', () => {
      const factory = defineProvider({
        id: 'my-provider',
        schema: testSchema,
        create: () => createMockProvider({ id: 'my-provider' }),
      });

      expect(factory.displayName).toBe('my-provider');
    });

    it('should default description to empty string', () => {
      const factory = defineProvider({
        id: 'no-desc',
        schema: testSchema,
        create: () => createMockProvider({ id: 'no-desc' }),
      });

      expect(factory.description).toBe('');
    });
  });

  describe('Zod validation rejects invalid options → BridgeError CONFIG', () => {
    it('should throw BridgeError CONFIG for missing required field', () => {
      const factory = defineProvider({
        id: 'zod-test',
        schema: testSchema,
        create: () => createMockProvider(),
      });

      expect(() => factory({} as any)).toThrow(BridgeError);

      try {
        factory({} as any);
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('Invalid options for provider "zod-test"');
        expect((err as BridgeError).message).toContain('key');
      }
    });

    it('should throw BridgeError CONFIG for empty string when min(1) required', () => {
      const factory = defineProvider({
        id: 'zod-empty',
        schema: testSchema,
        create: () => createMockProvider(),
      });

      expect(() => factory({ key: '' })).toThrow(BridgeError);

      try {
        factory({ key: '' });
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('key must be non-empty');
      }
    });

    it('should include providerId in error details', () => {
      const factory = defineProvider({
        id: 'detail-test',
        schema: testSchema,
        create: () => createMockProvider(),
      });

      try {
        factory({} as any);
      } catch (err) {
        expect((err as BridgeError).details).toHaveProperty('providerId', 'detail-test');
      }
    });
  });

  describe('create() returns invalid object → BridgeError CONFIG', () => {
    it('should throw when create() returns object without complete()', () => {
      const factory = defineProvider({
        id: 'no-complete',
        schema: testSchema,
        create: () => ({ id: 'no-complete', models: ['m1'] } as any),
      });

      expect(() => factory({ key: 'valid' })).toThrow(BridgeError);

      try {
        factory({ key: 'valid' });
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('complete()');
      }
    });

    it('should throw when create() returns object without id', () => {
      const factory = defineProvider({
        id: 'no-id',
        schema: testSchema,
        create: () => ({
          models: ['m1'],
          complete: async () => ({ text: '', stopReason: 'end_turn' }),
        } as any),
      });

      expect(() => factory({ key: 'valid' })).toThrow(BridgeError);

      try {
        factory({ key: 'valid' });
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('id');
      }
    });

    it('should throw when create() returns object without models', () => {
      const factory = defineProvider({
        id: 'no-models',
        schema: testSchema,
        create: () => ({
          id: 'no-models',
          complete: async () => ({ text: '', stopReason: 'end_turn' }),
        } as any),
      });

      expect(() => factory({ key: 'valid' })).toThrow(BridgeError);

      try {
        factory({ key: 'valid' });
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('models');
      }
    });
  });

  describe('callable factory returns AIProvider with kind and capabilities', () => {
    it('should attach kind from config when provider has no kind', () => {
      const factory = defineProvider({
        id: 'kind-attach',
        schema: testSchema,
        create: () => createMockProvider({ id: 'kind-attach' }),
        kind: 'embedding',
      });

      const provider = factory({ key: 'valid' });
      expect(provider.kind).toBe('embedding');
    });

    it('should preserve provider kind when provider already has kind', () => {
      const factory = defineProvider({
        id: 'kind-preserve',
        schema: testSchema,
        create: () => ({
          ...createMockProvider({ id: 'kind-preserve' }),
          kind: 'reranker' as ProviderKind,
        }),
        kind: 'llm',
      });

      const provider = factory({ key: 'valid' });
      expect(provider.kind).toBe('reranker');
    });

    it('should merge capabilities from config and provider', () => {
      const factory = defineProvider({
        id: 'caps-merge',
        schema: testSchema,
        create: () => ({
          ...createMockProvider({ id: 'caps-merge' }),
          capabilities: { vision: true },
        }),
        capabilities: { streaming: true, tools: true },
      });

      const provider = factory({ key: 'valid' });
      // Provider capabilities override config capabilities for overlapping keys
      // Base defaults (streaming: false from stream check, tools: false, vision: false, jsonMode: false)
      // + config capabilities (streaming: true, tools: true)
      // + provider capabilities (vision: true)
      expect(provider.capabilities).toEqual({
        streaming: true,
        tools: true,
        vision: true,
        jsonMode: false,
      });
    });

    it('should infer streaming: true when provider has stream method', () => {
      const factory = defineProvider({
        id: 'stream-infer',
        schema: testSchema,
        create: () => ({
          ...createMockProvider({ id: 'stream-infer' }),
          stream: () => { },
        }),
      });

      const provider = factory({ key: 'valid' });
      expect(provider.capabilities?.streaming).toBe(true);
    });

    it('should default streaming to false when provider has no stream method', () => {
      const factory = defineProvider({
        id: 'no-stream',
        schema: testSchema,
        create: () => createMockProvider({ id: 'no-stream' }),
      });

      const provider = factory({ key: 'valid' });
      expect(provider.capabilities?.streaming).toBe(false);
    });
  });

  describe('static metadata is readonly', () => {
    it('should not allow modification of static properties', () => {
      const factory = defineProvider({
        id: 'readonly-test',
        schema: testSchema,
        create: () => createMockProvider({ id: 'readonly-test' }),
      });

      // Attempting to write should throw in strict mode or silently fail
      expect(() => { (factory as any).id = 'changed'; }).toThrow();
      expect(factory.id).toBe('readonly-test');
    });
  });

  describe('Zod schema is accessible for introspection', () => {
    it('should expose the schema for JSON Schema generation', () => {
      const schema = z.object({
        apiKey: z.string(),
        models: z.array(z.string()),
      });

      const factory = defineProvider({
        id: 'schema-test',
        schema,
        create: () => createMockProvider({ id: 'schema-test' }),
      });

      expect(factory.schema).toBe(schema);
      // Schema can be used for parsing
      const result = factory.schema.safeParse({ apiKey: 'key', models: ['m1'] });
      expect(result.success).toBe(true);
    });
  });
});
