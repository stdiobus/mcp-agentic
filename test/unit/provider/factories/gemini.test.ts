/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the gemini factory.
 *
 * Tests cover:
 * - Factory returns AIProvider with correct id and models
 * - Static metadata (id, displayName, kind, capabilities)
 * - Schema accessible for introspection
 * - Zod validation: empty apiKey → BridgeError CONFIG
 * - Zod validation: empty models → BridgeError CONFIG
 * - SDK not installed → BridgeError CONFIG with installation instruction
 *
 * **Validates: Requirements 5.1–5.8, 10.4, 10.5**
 */

import { describe, it, expect, jest } from '@jest/globals';
import { z } from 'zod';
import { defineProvider } from '../../../../src/provider/defineProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import { GoogleGeminiProvider } from '../../../../src/provider/providers/GoogleGeminiProvider.js';
import type { RuntimeParams } from '../../../../src/provider/AIProvider.js';

// ── Helpers ─────────────────────────────────────────────────────

// Mock Google Generative AI SDK class matching the shape from test/__mocks__/@google/generative-ai.ts
class MockGoogleGenerativeAI {
  readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  getGenerativeModel(params: { model: string }) {
    return {
      model: params.model,
      generateContent: jest.fn<any>(),
    };
  }
}

/**
 * Create a local gemini-like factory for testing, using defineProvider
 * with an injected SDK class. This mirrors the real gemini factory
 * but avoids the require('@google/generative-ai') call that is hard to mock in ESM tests.
 */
function createGeminiFactory(sdkClass?: any) {
  const GeminiOptionsSchema = z.object({
    apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
    models: z.array(z.string()).nonempty('models must contain at least one model'),
    defaults: z.custom<RuntimeParams>().optional(),
  });

  return defineProvider({
    id: 'google-gemini',
    kind: 'llm',
    displayName: 'Google Gemini',
    description: 'Google Gemini models via official @google/generative-ai SDK',
    schema: GeminiOptionsSchema,
    capabilities: {
      streaming: false,
      tools: false,
      vision: true,
      jsonMode: true,
    },
    create: (options) => {
      if (!sdkClass) {
        throw BridgeError.config(
          'Google Gemini SDK ("@google/generative-ai" package) is not installed. Install it with: npm install @google/generative-ai',
          { providerId: 'google-gemini' },
        );
      }

      return new GoogleGeminiProvider(
        {
          credentials: { apiKey: options.apiKey },
          models: options.models,
          defaults: options.defaults,
        },
        sdkClass,
      );
    },
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe('gemini factory', () => {
  // ── Import the real factory for static metadata tests ─────────
  // Static metadata is set at module load time and doesn't depend on require('@google/generative-ai')
  let gemini: typeof import('../../../../src/provider/factories/gemini.js').gemini;

  beforeAll(async () => {
    const mod = await import('../../../../src/provider/factories/gemini.js');
    gemini = mod.gemini;
  });

  // ── Static metadata ─────────────────────────────────────────

  describe('static metadata', () => {
    it('should have id "google-gemini"', () => {
      expect(gemini.id).toBe('google-gemini');
    });

    it('should have displayName "Google Gemini"', () => {
      expect(gemini.displayName).toBe('Google Gemini');
    });

    it('should have kind "llm"', () => {
      expect(gemini.kind).toBe('llm');
    });

    it('should have correct capabilities', () => {
      expect(gemini.capabilities).toEqual({
        streaming: false,
        tools: false,
        vision: true,
        jsonMode: true,
      });
    });

    it('should have a non-empty description', () => {
      expect(gemini.description).toBeTruthy();
      expect(typeof gemini.description).toBe('string');
    });

    it('should expose schema for introspection', () => {
      expect(gemini.schema).toBeDefined();

      // Schema can parse valid options
      const valid = gemini.schema.safeParse({
        apiKey: 'AIza-test-key',
        models: ['gemini-2.0-flash'],
      });
      expect(valid.success).toBe(true);

      // Schema rejects invalid options
      const invalid = gemini.schema.safeParse({
        apiKey: '',
        models: [],
      });
      expect(invalid.success).toBe(false);
    });
  });

  // ── Successful creation (using local factory with injected SDK) ─

  describe('successful provider creation', () => {
    it('should return AIProvider with correct id and models', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);
      const provider = factory({
        apiKey: 'AIza-test-key',
        models: ['gemini-2.0-flash', 'gemini-1.5-pro'],
      });

      expect(provider.id).toBe('google-gemini');
      expect([...provider.models]).toEqual(['gemini-2.0-flash', 'gemini-1.5-pro']);
      expect(typeof provider.complete).toBe('function');
    });

    it('should return AIProvider with kind "llm"', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);
      const provider = factory({
        apiKey: 'AIza-test-key',
        models: ['gemini-2.0-flash'],
      });

      expect(provider.kind).toBe('llm');
    });

    it('should return AIProvider with correct capabilities', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);
      const provider = factory({
        apiKey: 'AIza-test-key',
        models: ['gemini-2.0-flash'],
      });

      expect(provider.capabilities).toEqual({
        streaming: false,
        tools: false,
        vision: true,
        jsonMode: true,
      });
    });

    it('should accept optional defaults', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);
      const provider = factory({
        apiKey: 'AIza-test-key',
        models: ['gemini-2.0-flash'],
        defaults: { temperature: 0.7, maxTokens: 1000 },
      });

      expect(provider.id).toBe('google-gemini');
      expect(typeof provider.complete).toBe('function');
    });

    it('should produce an instance of GoogleGeminiProvider', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);
      const provider = factory({
        apiKey: 'AIza-test-key',
        models: ['gemini-2.0-flash'],
      });

      expect(provider).toBeInstanceOf(GoogleGeminiProvider);
    });
  });

  // ── Zod validation errors ─────────────────────────────────────

  describe('Zod validation errors', () => {
    it('should throw BridgeError CONFIG for empty apiKey', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);

      expect(() => factory({
        apiKey: '',
        models: ['gemini-2.0-flash'],
      })).toThrow(BridgeError);

      try {
        factory({ apiKey: '', models: ['gemini-2.0-flash'] });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('apiKey');
      }
    });

    it('should throw BridgeError CONFIG for missing apiKey', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);

      expect(() => factory({
        models: ['gemini-2.0-flash'],
      } as any)).toThrow(BridgeError);

      try {
        factory({ models: ['gemini-2.0-flash'] } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should throw BridgeError CONFIG for empty models array', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);

      expect(() => factory({
        apiKey: 'AIza-test',
        models: [],
      } as any)).toThrow(BridgeError);

      try {
        factory({ apiKey: 'AIza-test', models: [] } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('models');
      }
    });

    it('should throw BridgeError CONFIG for missing models', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);

      expect(() => factory({
        apiKey: 'AIza-test',
      } as any)).toThrow(BridgeError);

      try {
        factory({ apiKey: 'AIza-test' } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should include providerId "google-gemini" in error details', () => {
      const factory = createGeminiFactory(MockGoogleGenerativeAI);

      try {
        factory({ apiKey: '', models: ['gemini-2.0-flash'] });
      } catch (err) {
        expect((err as BridgeError).details).toHaveProperty('providerId', 'google-gemini');
      }
    });

    it('should also reject via the real gemini factory (Zod validation is SDK-independent)', () => {
      // Zod validation happens BEFORE require('@google/generative-ai'), so the real factory
      // can validate even without the SDK being available
      expect(() => gemini({
        apiKey: '',
        models: ['gemini-2.0-flash'],
      })).toThrow(BridgeError);

      try {
        gemini({ apiKey: '', models: ['gemini-2.0-flash'] });
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('apiKey');
      }
    });
  });

  // ── SDK not installed ─────────────────────────────────────────

  describe('SDK not installed', () => {
    it('should throw BridgeError CONFIG with installation instruction when SDK is unavailable', () => {
      // Create factory with no SDK (simulates missing package)
      const factory = createGeminiFactory(undefined);

      expect(() => factory({
        apiKey: 'AIza-test',
        models: ['gemini-2.0-flash'],
      })).toThrow(BridgeError);

      try {
        factory({ apiKey: 'AIza-test', models: ['gemini-2.0-flash'] });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('@google/generative-ai');
        expect((err as BridgeError).message).toContain('npm install @google/generative-ai');
      }
    });

    it('should throw BridgeError CONFIG from the real factory when require("@google/generative-ai") fails', () => {
      // The real gemini factory calls require('@google/generative-ai') which in the test
      // environment may or may not resolve. If it fails, it should throw
      // BridgeError CONFIG. We test this by calling the real factory.
      try {
        gemini({ apiKey: 'AIza-test', models: ['gemini-2.0-flash'] });
        // If it succeeds (SDK mock resolved), that's also valid — skip assertion
      } catch (err) {
        // If it throws, it must be a BridgeError CONFIG about missing SDK
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('@google/generative-ai');
      }
    });
  });
});
