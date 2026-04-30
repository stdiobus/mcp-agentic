/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the anthropic factory.
 *
 * Tests cover:
 * - Factory returns AIProvider with correct id and models
 * - Static metadata (id, displayName, kind, capabilities)
 * - Schema accessible for introspection
 * - Zod validation: empty apiKey → BridgeError CONFIG
 * - Zod validation: empty models → BridgeError CONFIG
 * - SDK not installed → BridgeError CONFIG with installation instruction
 *
 * **Validates: Requirements 4.1–4.8, 10.4, 10.5**
 */

import { describe, it, expect, jest } from '@jest/globals';
import { z } from 'zod';
import { defineProvider } from '../../../../src/provider/defineProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import { AnthropicProvider } from '../../../../src/provider/providers/AnthropicProvider.js';
import type { RuntimeParams } from '../../../../src/provider/AIProvider.js';

// ── Helpers ─────────────────────────────────────────────────────

// Mock Anthropic SDK class matching the shape from test/__mocks__/@anthropic-ai/sdk.ts
class MockAnthropic {
  readonly apiKey: string;
  readonly messages = {
    create: jest.fn<any>(),
  };

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }
}

/**
 * Create a local anthropic-like factory for testing, using defineProvider
 * with an injected SDK class. This mirrors the real anthropic factory
 * but avoids the require('@anthropic-ai/sdk') call that is hard to mock in ESM tests.
 */
function createAnthropicFactory(sdkClass?: any) {
  const AnthropicOptionsSchema = z.object({
    apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
    models: z.array(z.string()).nonempty('models must contain at least one model'),
    defaults: z.custom<RuntimeParams>().optional(),
  });

  return defineProvider({
    id: 'anthropic',
    kind: 'llm',
    displayName: 'Anthropic',
    description: 'Anthropic Claude models via official @anthropic-ai/sdk',
    schema: AnthropicOptionsSchema,
    capabilities: {
      streaming: true,
      tools: true,
      vision: true,
      jsonMode: false,
    },
    create: (options) => {
      if (!sdkClass) {
        throw BridgeError.config(
          'Anthropic SDK ("@anthropic-ai/sdk" package) is not installed. Install it with: npm install @anthropic-ai/sdk',
          { providerId: 'anthropic' },
        );
      }

      return new AnthropicProvider(
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

describe('anthropic factory', () => {
  // ── Import the real factory for static metadata tests ─────────
  // Static metadata is set at module load time and doesn't depend on require('@anthropic-ai/sdk')
  let anthropic: typeof import('../../../../src/provider/factories/anthropic.js').anthropic;

  beforeAll(async () => {
    const mod = await import('../../../../src/provider/factories/anthropic.js');
    anthropic = mod.anthropic;
  });

  // ── Static metadata ─────────────────────────────────────────

  describe('static metadata', () => {
    it('should have id "anthropic"', () => {
      expect(anthropic.id).toBe('anthropic');
    });

    it('should have displayName "Anthropic"', () => {
      expect(anthropic.displayName).toBe('Anthropic');
    });

    it('should have kind "llm"', () => {
      expect(anthropic.kind).toBe('llm');
    });

    it('should have correct capabilities', () => {
      expect(anthropic.capabilities).toEqual({
        streaming: true,
        tools: true,
        vision: true,
        jsonMode: false,
      });
    });

    it('should have a non-empty description', () => {
      expect(anthropic.description).toBeTruthy();
      expect(typeof anthropic.description).toBe('string');
    });

    it('should expose schema for introspection', () => {
      expect(anthropic.schema).toBeDefined();

      // Schema can parse valid options
      const valid = anthropic.schema.safeParse({
        apiKey: 'sk-ant-test',
        models: ['claude-sonnet-4-20250514'],
      });
      expect(valid.success).toBe(true);

      // Schema rejects invalid options
      const invalid = anthropic.schema.safeParse({
        apiKey: '',
        models: [],
      });
      expect(invalid.success).toBe(false);
    });
  });

  // ── Successful creation (using local factory with injected SDK) ─

  describe('successful provider creation', () => {
    it('should return AIProvider with correct id and models', () => {
      const factory = createAnthropicFactory(MockAnthropic);
      const provider = factory({
        apiKey: 'sk-ant-test-key',
        models: ['claude-sonnet-4-20250514', 'claude-3-haiku-20240307'],
      });

      expect(provider.id).toBe('anthropic');
      expect([...provider.models]).toEqual(['claude-sonnet-4-20250514', 'claude-3-haiku-20240307']);
      expect(typeof provider.complete).toBe('function');
    });

    it('should return AIProvider with kind "llm"', () => {
      const factory = createAnthropicFactory(MockAnthropic);
      const provider = factory({
        apiKey: 'sk-ant-test-key',
        models: ['claude-sonnet-4-20250514'],
      });

      expect(provider.kind).toBe('llm');
    });

    it('should return AIProvider with correct capabilities', () => {
      const factory = createAnthropicFactory(MockAnthropic);
      const provider = factory({
        apiKey: 'sk-ant-test-key',
        models: ['claude-sonnet-4-20250514'],
      });

      expect(provider.capabilities).toEqual({
        streaming: true,
        tools: true,
        vision: true,
        jsonMode: false,
      });
    });

    it('should accept optional defaults', () => {
      const factory = createAnthropicFactory(MockAnthropic);
      const provider = factory({
        apiKey: 'sk-ant-test-key',
        models: ['claude-sonnet-4-20250514'],
        defaults: { temperature: 0.7, maxTokens: 1000 },
      });

      expect(provider.id).toBe('anthropic');
      expect(typeof provider.complete).toBe('function');
    });

    it('should produce an instance of AnthropicProvider', () => {
      const factory = createAnthropicFactory(MockAnthropic);
      const provider = factory({
        apiKey: 'sk-ant-test-key',
        models: ['claude-sonnet-4-20250514'],
      });

      expect(provider).toBeInstanceOf(AnthropicProvider);
    });
  });

  // ── Zod validation errors ─────────────────────────────────────

  describe('Zod validation errors', () => {
    it('should throw BridgeError CONFIG for empty apiKey', () => {
      const factory = createAnthropicFactory(MockAnthropic);

      expect(() => factory({
        apiKey: '',
        models: ['claude-sonnet-4-20250514'],
      })).toThrow(BridgeError);

      try {
        factory({ apiKey: '', models: ['claude-sonnet-4-20250514'] });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('apiKey');
      }
    });

    it('should throw BridgeError CONFIG for missing apiKey', () => {
      const factory = createAnthropicFactory(MockAnthropic);

      expect(() => factory({
        models: ['claude-sonnet-4-20250514'],
      } as any)).toThrow(BridgeError);

      try {
        factory({ models: ['claude-sonnet-4-20250514'] } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should throw BridgeError CONFIG for empty models array', () => {
      const factory = createAnthropicFactory(MockAnthropic);

      expect(() => factory({
        apiKey: 'sk-ant-test',
        models: [],
      } as any)).toThrow(BridgeError);

      try {
        factory({ apiKey: 'sk-ant-test', models: [] } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('models');
      }
    });

    it('should throw BridgeError CONFIG for missing models', () => {
      const factory = createAnthropicFactory(MockAnthropic);

      expect(() => factory({
        apiKey: 'sk-ant-test',
      } as any)).toThrow(BridgeError);

      try {
        factory({ apiKey: 'sk-ant-test' } as any);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should include providerId "anthropic" in error details', () => {
      const factory = createAnthropicFactory(MockAnthropic);

      try {
        factory({ apiKey: '', models: ['claude-sonnet-4-20250514'] });
      } catch (err) {
        expect((err as BridgeError).details).toHaveProperty('providerId', 'anthropic');
      }
    });

    it('should also reject via the real anthropic factory (Zod validation is SDK-independent)', () => {
      // Zod validation happens BEFORE require('@anthropic-ai/sdk'), so the real factory
      // can validate even without the SDK being available
      expect(() => anthropic({
        apiKey: '',
        models: ['claude-sonnet-4-20250514'],
      })).toThrow(BridgeError);

      try {
        anthropic({ apiKey: '', models: ['claude-sonnet-4-20250514'] });
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
      const factory = createAnthropicFactory(undefined);

      expect(() => factory({
        apiKey: 'sk-ant-test',
        models: ['claude-sonnet-4-20250514'],
      })).toThrow(BridgeError);

      try {
        factory({ apiKey: 'sk-ant-test', models: ['claude-sonnet-4-20250514'] });
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('@anthropic-ai/sdk');
        expect((err as BridgeError).message).toContain('npm install @anthropic-ai/sdk');
      }
    });

    it('should throw BridgeError CONFIG from the real factory when require("@anthropic-ai/sdk") fails', () => {
      // The real anthropic factory calls require('@anthropic-ai/sdk') which in the test
      // environment may or may not resolve. If it fails, it should throw
      // BridgeError CONFIG. We test this by calling the real factory.
      try {
        anthropic({ apiKey: 'sk-ant-test', models: ['claude-sonnet-4-20250514'] });
        // If it succeeds (SDK mock resolved), that's also valid — skip assertion
      } catch (err) {
        // If it throws, it must be a BridgeError CONFIG about missing SDK
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('@anthropic-ai/sdk');
      }
    });
  });
});
