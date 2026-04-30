/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for built-in provider factories (openAI, anthropic, gemini).
 *
 * Property 3: Zod schema validation rejects invalid options for all built-in factories.
 * Property 4: Round-trip equivalence — factory and class produce identical complete() results.
 *
 * **Validates: Requirements 3.2, 3.4, 3.6, 4.2, 4.4, 4.6, 5.2, 5.4, 5.6, 10.4, 13.6**
 */

import { describe, it, expect, jest } from '@jest/globals';
import * as fc from 'fast-check';
import { z } from 'zod';
import { defineProvider } from '../../../../src/provider/defineProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import { OpenAIProvider } from '../../../../src/provider/providers/OpenAIProvider.js';
import { AnthropicProvider } from '../../../../src/provider/providers/AnthropicProvider.js';
import { GoogleGeminiProvider } from '../../../../src/provider/providers/GoogleGeminiProvider.js';
import type { AIProvider, RuntimeParams, ChatMessage, AIProviderResult } from '../../../../src/provider/AIProvider.js';

// ── Mock SDK classes ────────────────────────────────────────────

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

class MockAnthropic {
  readonly apiKey: string;
  readonly messages = {
    create: jest.fn<any>(),
  };

  constructor(opts: { apiKey: string }) {
    this.apiKey = opts.apiKey;
  }
}

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

// ── Factory helpers (mirror real factories with injected SDKs) ──

function createOpenAIFactory(sdkClass?: any) {
  const schema = z.object({
    apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
    models: z.array(z.string()).nonempty('models must contain at least one model'),
    defaults: z.custom<RuntimeParams>().optional(),
  });

  return defineProvider({
    id: 'openai',
    kind: 'llm',
    displayName: 'OpenAI',
    description: 'OpenAI GPT models via official openai npm SDK',
    schema,
    capabilities: { streaming: true, tools: true, vision: true, jsonMode: true },
    create: (options) => {
      if (!sdkClass) {
        throw BridgeError.config(
          'OpenAI SDK ("openai" package) is not installed. Install it with: npm install openai',
          { providerId: 'openai' },
        );
      }
      return new OpenAIProvider(
        { credentials: { apiKey: options.apiKey }, models: options.models, defaults: options.defaults },
        sdkClass,
      );
    },
  });
}

function createAnthropicFactory(sdkClass?: any) {
  const schema = z.object({
    apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
    models: z.array(z.string()).nonempty('models must contain at least one model'),
    defaults: z.custom<RuntimeParams>().optional(),
  });

  return defineProvider({
    id: 'anthropic',
    kind: 'llm',
    displayName: 'Anthropic',
    description: 'Anthropic Claude models via official @anthropic-ai/sdk',
    schema,
    capabilities: { streaming: true, tools: true, vision: true, jsonMode: false },
    create: (options) => {
      if (!sdkClass) {
        throw BridgeError.config(
          'Anthropic SDK ("@anthropic-ai/sdk" package) is not installed. Install it with: npm install @anthropic-ai/sdk',
          { providerId: 'anthropic' },
        );
      }
      return new AnthropicProvider(
        { credentials: { apiKey: options.apiKey }, models: options.models, defaults: options.defaults },
        sdkClass,
      );
    },
  });
}

function createGeminiFactory(sdkClass?: any) {
  const schema = z.object({
    apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
    models: z.array(z.string()).nonempty('models must contain at least one model'),
    defaults: z.custom<RuntimeParams>().optional(),
  });

  return defineProvider({
    id: 'google-gemini',
    kind: 'llm',
    displayName: 'Google Gemini',
    description: 'Google Gemini models via official @google/generative-ai SDK',
    schema,
    capabilities: { streaming: false, tools: false, vision: true, jsonMode: true },
    create: (options) => {
      if (!sdkClass) {
        throw BridgeError.config(
          'Google Gemini SDK ("@google/generative-ai" package) is not installed. Install it with: npm install @google/generative-ai',
          { providerId: 'google-gemini' },
        );
      }
      return new GoogleGeminiProvider(
        { credentials: { apiKey: options.apiKey }, models: options.models, defaults: options.defaults },
        sdkClass,
      );
    },
  });
}

// ── Factory descriptors for parameterized tests ─────────────────

interface FactoryDescriptor {
  name: string;
  providerId: string;
  createFactory: (sdk?: any) => ReturnType<typeof defineProvider>;
  sdkClass: any;
}

const FACTORIES: FactoryDescriptor[] = [
  { name: 'openAI', providerId: 'openai', createFactory: createOpenAIFactory, sdkClass: MockOpenAI },
  { name: 'anthropic', providerId: 'anthropic', createFactory: createAnthropicFactory, sdkClass: MockAnthropic },
  { name: 'gemini', providerId: 'google-gemini', createFactory: createGeminiFactory, sdkClass: MockGoogleGenerativeAI },
];

// ── Property 3: Zod schema validation for built-in factories ────

// Feature: provider-factory-api, Property 3: Zod schema validation rejects invalid options for all built-in factories
describe('Property 3: Zod schema validation rejects invalid options for all built-in factories', () => {
  describe.each(FACTORIES)('$name factory', ({ name, providerId, createFactory, sdkClass }) => {
    const factory = createFactory(sdkClass);

    it('should throw BridgeError CONFIG for empty apiKey with arbitrary non-empty models', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
          (models) => {
            try {
              factory({ apiKey: '', models } as any);
              // Should not reach here
              throw new Error('Expected BridgeError but factory succeeded');
            } catch (err) {
              expect(err).toBeInstanceOf(BridgeError);
              expect((err as BridgeError).type).toBe('CONFIG');
              expect((err as BridgeError).message).toContain('apiKey');
              expect((err as BridgeError).details).toHaveProperty('providerId', providerId);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should throw BridgeError CONFIG for empty models array with arbitrary non-empty apiKey', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (apiKey) => {
            try {
              factory({ apiKey, models: [] } as any);
              throw new Error('Expected BridgeError but factory succeeded');
            } catch (err) {
              expect(err).toBeInstanceOf(BridgeError);
              expect((err as BridgeError).type).toBe('CONFIG');
              expect((err as BridgeError).message).toContain('models');
              expect((err as BridgeError).details).toHaveProperty('providerId', providerId);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should throw BridgeError CONFIG for missing apiKey (undefined)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
          (models) => {
            try {
              factory({ models } as any);
              throw new Error('Expected BridgeError but factory succeeded');
            } catch (err) {
              expect(err).toBeInstanceOf(BridgeError);
              expect((err as BridgeError).type).toBe('CONFIG');
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should throw BridgeError CONFIG for missing models (undefined)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (apiKey) => {
            try {
              factory({ apiKey } as any);
              throw new Error('Expected BridgeError but factory succeeded');
            } catch (err) {
              expect(err).toBeInstanceOf(BridgeError);
              expect((err as BridgeError).type).toBe('CONFIG');
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should throw BridgeError CONFIG for both empty apiKey and empty models', () => {
      try {
        factory({ apiKey: '', models: [] } as any);
        throw new Error('Expected BridgeError but factory succeeded');
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).details).toHaveProperty('providerId', providerId);
      }
    });

    it('should accept valid options with arbitrary non-empty apiKey and non-empty models', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }),
          (apiKey, models) => {
            // Valid options should NOT throw BridgeError CONFIG for Zod validation
            // (may throw for other reasons like SDK issues, but not Zod)
            const provider = factory({ apiKey, models });
            expect(provider).toBeDefined();
            expect(provider.id).toBe(providerId);
            expect([...provider.models]).toEqual(models);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});


// ── Property 4: Round-trip equivalence — factory vs class ───────

// Feature: provider-factory-api, Property 4: Factory and class produce identical complete() results
describe('Property 4: Factory and class produce identical complete() results', () => {
  /**
   * For each built-in factory, we verify that:
   * 1. Creating a provider via the factory with flat options
   * 2. Creating a provider via the class with equivalent ProviderConfig
   * Both produce identical complete() results for the same messages and params.
   *
   * This is the round-trip equivalence property: the factory is a thin wrapper
   * that maps flat options to ProviderConfig, so the underlying behavior must
   * be identical.
   */

  // ── Arbitraries ─────────────────────────────────────────────

  /** Arbitrary for a non-empty API key. */
  const arbApiKey = fc.string({ minLength: 1, maxLength: 50 });

  /** Arbitrary for a non-empty model list. */
  const arbModels = fc.array(
    fc.string({ minLength: 1, maxLength: 30 }),
    { minLength: 1, maxLength: 3 },
  );

  /** Arbitrary for a simple ChatMessage. */
  const arbMessage: fc.Arbitrary<ChatMessage> = fc.record({
    role: fc.constantFrom('user' as const, 'assistant' as const),
    content: fc.string({ minLength: 1, maxLength: 200 }),
  });

  /** Arbitrary for a list of messages (at least one). */
  const arbMessages = fc.array(arbMessage, { minLength: 1, maxLength: 5 });

  /** Arbitrary for a response text. */
  const arbResponseText = fc.string({ minLength: 0, maxLength: 500 });

  /** Arbitrary for usage tokens. */
  const arbTokenCount = fc.integer({ min: 0, max: 10000 });

  // ── OpenAI round-trip ─────────────────────────────────────────

  describe('openAI factory vs OpenAIProvider class', () => {
    it('should produce identical complete() results for arbitrary valid inputs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbApiKey,
          arbModels,
          arbMessages,
          arbResponseText,
          arbTokenCount,
          arbTokenCount,
          async (apiKey, models, messages, responseText, inputTokens, outputTokens) => {
            // Canonical OpenAI SDK response shape
            const sdkResponse = {
              choices: [{
                message: { content: responseText },
                finish_reason: 'stop',
              }],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
              },
            };

            // Create mock SDK class that returns the same response
            const createFn1 = jest.fn<any>().mockResolvedValue(sdkResponse);
            const createFn2 = jest.fn<any>().mockResolvedValue(sdkResponse);

            class MockSDK1 {
              readonly apiKey: string;
              readonly chat = { completions: { create: createFn1 } };
              constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
            }

            class MockSDK2 {
              readonly apiKey: string;
              readonly chat = { completions: { create: createFn2 } };
              constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
            }

            // Path 1: Factory
            const factoryProvider = createOpenAIFactory(MockSDK1)({
              apiKey,
              models,
            });

            // Path 2: Class directly
            const classProvider = new OpenAIProvider(
              { credentials: { apiKey }, models },
              MockSDK2 as any,
            );

            const params: RuntimeParams = { model: models[0] };

            const factoryResult = await factoryProvider.complete(messages, params);
            const classResult = await classProvider.complete(messages, params);

            // Results must be identical
            expect(factoryResult.text).toBe(classResult.text);
            expect(factoryResult.stopReason).toBe(classResult.stopReason);
            expect(factoryResult.usage).toEqual(classResult.usage);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  // ── Anthropic round-trip ──────────────────────────────────────

  describe('anthropic factory vs AnthropicProvider class', () => {
    it('should produce identical complete() results for arbitrary valid inputs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbApiKey,
          arbModels,
          arbMessages,
          arbResponseText,
          arbTokenCount,
          arbTokenCount,
          async (apiKey, models, messages, responseText, inputTokens, outputTokens) => {
            // Canonical Anthropic SDK response shape
            const sdkResponse = {
              content: [{ type: 'text', text: responseText }],
              stop_reason: 'end_turn',
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
              },
            };

            const createFn1 = jest.fn<any>().mockResolvedValue(sdkResponse);
            const createFn2 = jest.fn<any>().mockResolvedValue(sdkResponse);

            class MockSDK1 {
              readonly apiKey: string;
              readonly messages = { create: createFn1 };
              constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
            }

            class MockSDK2 {
              readonly apiKey: string;
              readonly messages = { create: createFn2 };
              constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
            }

            // Path 1: Factory
            const factoryProvider = createAnthropicFactory(MockSDK1)({
              apiKey,
              models,
            });

            // Path 2: Class directly
            const classProvider = new AnthropicProvider(
              { credentials: { apiKey }, models },
              MockSDK2 as any,
            );

            const params: RuntimeParams = { model: models[0] };

            const factoryResult = await factoryProvider.complete(messages, params);
            const classResult = await classProvider.complete(messages, params);

            // Results must be identical
            expect(factoryResult.text).toBe(classResult.text);
            expect(factoryResult.stopReason).toBe(classResult.stopReason);
            expect(factoryResult.usage).toEqual(classResult.usage);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  // ── Gemini round-trip ─────────────────────────────────────────

  describe('gemini factory vs GoogleGeminiProvider class', () => {
    it('should produce identical complete() results for arbitrary valid inputs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbApiKey,
          arbModels,
          arbMessages,
          arbResponseText,
          arbTokenCount,
          arbTokenCount,
          async (apiKey, models, messages, responseText, inputTokens, outputTokens) => {
            // Canonical Gemini SDK response shape
            const sdkResponse = {
              response: {
                candidates: [{
                  content: { parts: [{ text: responseText }] },
                  finishReason: 'STOP',
                }],
                usageMetadata: {
                  promptTokenCount: inputTokens,
                  candidatesTokenCount: outputTokens,
                },
              },
            };

            const generateFn1 = jest.fn<any>().mockResolvedValue(sdkResponse);
            const generateFn2 = jest.fn<any>().mockResolvedValue(sdkResponse);

            class MockSDK1 {
              readonly apiKey: string;
              constructor(apiKey: string) { this.apiKey = apiKey; }
              getGenerativeModel(_params: { model: string }) {
                return { generateContent: generateFn1 };
              }
            }

            class MockSDK2 {
              readonly apiKey: string;
              constructor(apiKey: string) { this.apiKey = apiKey; }
              getGenerativeModel(_params: { model: string }) {
                return { generateContent: generateFn2 };
              }
            }

            // Path 1: Factory
            const factoryProvider = createGeminiFactory(MockSDK1)({
              apiKey,
              models,
            });

            // Path 2: Class directly
            const classProvider = new GoogleGeminiProvider(
              { credentials: { apiKey }, models },
              MockSDK2 as any,
            );

            const params: RuntimeParams = { model: models[0] };

            const factoryResult = await factoryProvider.complete(messages, params);
            const classResult = await classProvider.complete(messages, params);

            // Results must be identical
            expect(factoryResult.text).toBe(classResult.text);
            expect(factoryResult.stopReason).toBe(classResult.stopReason);
            expect(factoryResult.usage).toEqual(classResult.usage);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  // ── Cross-factory: RuntimeParams defaults equivalence ─────────

  describe('RuntimeParams defaults equivalence', () => {
    it('should produce identical results when factory and class both receive defaults', async () => {
      // Test with explicit defaults to verify the mapping path
      const sdkResponse = {
        choices: [{
          message: { content: 'hello' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };

      const createFn1 = jest.fn<any>().mockResolvedValue(sdkResponse);
      const createFn2 = jest.fn<any>().mockResolvedValue(sdkResponse);

      class MockSDK1 {
        readonly apiKey: string;
        readonly chat = { completions: { create: createFn1 } };
        constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
      }

      class MockSDK2 {
        readonly apiKey: string;
        readonly chat = { completions: { create: createFn2 } };
        constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
      }

      const defaults: RuntimeParams = { temperature: 0.5, maxTokens: 500 };

      // Factory with defaults
      const factoryProvider = createOpenAIFactory(MockSDK1)({
        apiKey: 'sk-test',
        models: ['gpt-4o'],
        defaults,
      });

      // Class with equivalent defaults
      const classProvider = new OpenAIProvider(
        { credentials: { apiKey: 'sk-test' }, models: ['gpt-4o'], defaults },
        MockSDK2 as any,
      );

      const params: RuntimeParams = { model: 'gpt-4o' };
      const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];

      const factoryResult = await factoryProvider.complete(messages, params);
      const classResult = await classProvider.complete(messages, params);

      expect(factoryResult).toEqual(classResult);

      // Verify both SDK calls received the same body shape
      expect(createFn1).toHaveBeenCalledTimes(1);
      expect(createFn2).toHaveBeenCalledTimes(1);

      const factoryBody = createFn1.mock.calls[0]![0] as Record<string, unknown>;
      const classBody = createFn2.mock.calls[0]![0] as Record<string, unknown>;

      expect(factoryBody).toEqual(classBody);
    });
  });
});
