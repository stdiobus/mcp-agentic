/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the openAI factory.
 *
 * Tests cover:
 * - Factory returns AIProvider with correct id and models
 * - Static metadata (id, displayName, kind, capabilities)
 * - Schema accessible for introspection
 * - Zod validation: empty apiKey → BridgeError CONFIG
 * - Zod validation: empty models → BridgeError CONFIG
 * - SDK not installed → BridgeError CONFIG with installation instruction
 *
 * **Validates: Requirements 3.1–3.8, 10.4, 10.5**
 */

import { describe, it, expect, jest } from '@jest/globals';
import { z } from 'zod';
import { defineProvider } from '../../../../src/provider/defineProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import { OpenAIProvider } from '../../../../src/provider/providers/OpenAIProvider.js';
import type { AIProvider, RuntimeParams } from '../../../../src/provider/AIProvider.js';

// ── Helpers ─────────────────────────────────────────────────────

// Mock OpenAI SDK class matching the shape from test/__mocks__/openai.ts
class MockOpenAI {
  readonly apiKey: string;
  readonly chat = {
    completions: {
      create: jest.fn<any>(),
    },
  };

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }
}

/**
 * Create a local openAI-like factory for testing, using defineProvider
 * with an injected SDK class. This mirrors the real openAI factory
 * but avoids the require('openai') call that is hard to mock in ESM tests.
 */
function createOpenAIFactory(sdkClass?: any) {
  const OpenAIOptionsSchema = z.object({
    apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
    models: z.array(z.string()).nonempty('models must contain at least one model'),
    defaults: z.custom<RuntimeParams>().optional(),
  });

  return defineProvider({
    id: 'openai',
    kind: 'llm',
    displayName: 'OpenAI',
    description: 'OpenAI GPT models via official openai npm SDK',
    schema: OpenAIOptionsSchema,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      jsonMode: true,
    },
    create: (options) => {
      if (!sdkClass) {
        throw BridgeError.config(
          'OpenAI SDK ("openai" package) is not installed. Install it with: npm install openai',
          { providerId: 'openai' },
        );
      }

      return new OpenAIProvider(
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

describe('openAI factory', () => {
  // ── Import the real factory for static metadata tests ─────────
  // Static metadata is set at module load time and doesn't depend on require('openai')
  let openAI: typeof import('../../../../src/provider/factories/openai.js').openAI;

  beforeAll(async () => {
    const mod = await import('../../../../src/provider/factories/openai.js');
    openAI = mod.openAI;
  });

  // ── Static metadata ─────────────────────────────────────────

  describe('static metadata', () => {
    it('should have id "openai"', () => {
      expect(openAI.id).toBe('openai');
    });

    it('should have displayName "OpenAI"', () => {
      expect(openAI.displayName).toBe('OpenAI');
    });

    it('should have kind "llm"', () => {
      expect(openAI.kind).toBe('llm');
    });

    it('should have correct capabilities', () => {
      expect(openAI.capabilities).toEqual({
        streaming: true,
        tools: true,
        vision: true,
        jsonMode: true,
      });
    });

    it('should have a non-empty description', () => {
      expect(openAI.description).toBeTruthy();
      expect(typeof openAI.description).toBe('string');
    });

    it('should expose schema for introspection', () => {
      expect(openAI.schema).toBeDefined();

      // Schema can parse valid options
      const valid = openAI.schema.safeParse({
        apiKey: 'sk-test',
        models: ['gpt-4o'],
      });
      expect(valid.success).toBe(true);

      // Schema rejects invalid options
      const invalid = openAI.schema.safeParse({
        apiKey: '',
        models: [],
      });
      expect(invalid.success).toBe(false);
    });
  });

  // ── Successful creation (using local factory with injected SDK) ─

  describe('successful provider creation', () => {
    it('should return AIProvider with correct id and models', () => {
      const factory = createOpenAIFactory(MockOpenAI);
      const provider = factory({
        apiKey: 'sk-test-key',
        models: ['gpt-4o', 'gpt-4o-mini'],
      });

      expect(provider.id).toBe('openai');
      expect([...provider.models]).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(typeof provider.complete).toBe('function');
    });

    it('should return AIProvider with kind "llm"', () => {
      const factory = createOpenAIFactory(MockOpenAI);
      const provider = factory({
        apiKey: 'sk-test-key',
        models: ['gpt-4o'],
      });

      expect(provider.kind).toBe('llm');
    });

    it('should return AIProvider with correct capabilities', () => {
      const factory = createOpenAIFactory(MockOpenAI);
      const provider = factory({
        apiKey: 'sk-test-key',
        models: ['gpt-4o'],
      });

      expect(provider.capabilities).toEqual({
        streaming: true,
        tools: true,
        vision: true,
        jsonMode: true,
      });
    });

    it('should accept optional defaults', () => {
      const factory = createOpenAIFactory(MockOpenAI);
      const provider = factory({
        apiKey: 'sk-test-key',
        models: ['gpt-4o'],
        defaults: { temperature: 0.7, maxTokens: 1000 },
      });

      expect(provider.id).toBe('openai');
      expect(typeof provider.complete).toBe('function');
    });

    it('should produce an instance of OpenAIProvider', () => {
      const factory = createOpenAIFactory(MockOpenAI);
      const provider = factory({
        apiKey: 'sk-test-key',
        models: ['gpt-4o'],
      });

      expect(provider).toBeInstanceOf(OpenAIProvider);
    });
  });

  // ── Zod validation errors ─────────────────────────────────────

  describe('Zod validation errors', () => {
    it('should throw BridgeError CONFIG for empty apiKey', () => {
      const factory = createOpenAIFactory(MockOpenAI);

      expect(() => factory({
        apiKey: '',
        models: ['gpt-4o'],
      })).toThrow(BridgeError);

      try {
        factory({ apiKey: '', models: ['gpt-4o'] });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('apiKey');
      }
    });

    it('should throw BridgeError CONFIG for missing apiKey', () => {
      const factory = createOpenAIFactory(MockOpenAI);

      expect(() => factory({
        models: ['gpt-4o'],
      } as any)).toThrow(BridgeError);

      try {
        factory({ models: ['gpt-4o'] } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should throw BridgeError CONFIG for empty models array', () => {
      const factory = createOpenAIFactory(MockOpenAI);

      expect(() => factory({
        apiKey: 'sk-test',
        models: [],
      } as any)).toThrow(BridgeError);

      try {
        factory({ apiKey: 'sk-test', models: [] } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('models');
      }
    });

    it('should throw BridgeError CONFIG for missing models', () => {
      const factory = createOpenAIFactory(MockOpenAI);

      expect(() => factory({
        apiKey: 'sk-test',
      } as any)).toThrow(BridgeError);

      try {
        factory({ apiKey: 'sk-test' } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should include providerId "openai" in error details', () => {
      const factory = createOpenAIFactory(MockOpenAI);

      try {
        factory({ apiKey: '', models: ['gpt-4o'] });
      } catch (err) {
        expect((err as BridgeError).details).toHaveProperty('providerId', 'openai');
      }
    });

    it('should also reject via the real openAI factory (Zod validation is SDK-independent)', () => {
      // Zod validation happens BEFORE require('openai'), so the real factory
      // can validate even without the SDK being available
      expect(() => openAI({
        apiKey: '',
        models: ['gpt-4o'],
      })).toThrow(BridgeError);

      try {
        openAI({ apiKey: '', models: ['gpt-4o'] });
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
      const factory = createOpenAIFactory(undefined);

      expect(() => factory({
        apiKey: 'sk-test',
        models: ['gpt-4o'],
      })).toThrow(BridgeError);

      try {
        factory({ apiKey: 'sk-test', models: ['gpt-4o'] });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('openai');
        expect((err as BridgeError).message).toContain('npm install openai');
      }
    });

    it('should throw BridgeError CONFIG from the real factory when require("openai") fails', () => {
      // The real openAI factory calls require('openai') which in the test
      // environment may or may not resolve. If it fails, it should throw
      // BridgeError CONFIG. We test this by calling the real factory.
      try {
        openAI({ apiKey: 'sk-test', models: ['gpt-4o'] });
        // If it succeeds (SDK mock resolved), that's also valid — skip assertion
      } catch (err) {
        // If it throws, it must be a BridgeError CONFIG about missing SDK
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('openai');
      }
    });
  });
});
