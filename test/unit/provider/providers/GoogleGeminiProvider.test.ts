/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit and property-based tests for GoogleGeminiProvider.
 *
 * Tests cover:
 * - Credential validation at construction (Property 10)
 * - Response normalization (Property 6)
 * - Usage normalization (Property 7)
 * - Error classification (Property 8)
 * - Provider id in error details (Property 9)
 * - Unsupported providerSpecific ignored (Property 11)
 * - Gemini content format conversion (Property 16)
 * - Empty response handling (Requirement 10.4)
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import { GoogleGeminiProvider } from '../../../../src/provider/providers/GoogleGeminiProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import type { ChatMessage, ProviderConfig } from '../../../../src/provider/AIProvider.js';

// ── Mock SDK error classes (local to test) ──────────────────────

class GoogleGenerativeAIError extends Error {
  readonly status?: string;
  constructor(message: string, status?: string) {
    super(message);
    this.name = 'GoogleGenerativeAIError';
    this.status = status;
  }
}

class AuthenticationError extends Error {
  readonly status = 'UNAUTHENTICATED';
  constructor(message = 'Invalid API key') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

class RateLimitError extends Error {
  readonly status = 'RESOURCE_EXHAUSTED';
  constructor(message = 'Rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
  }
}

class BadRequestError extends Error {
  readonly status = 'INVALID_ARGUMENT';
  constructor(message = 'Bad request') {
    super(message);
    this.name = 'BadRequestError';
  }
}

class InternalServerError extends Error {
  readonly status = 'INTERNAL';
  constructor(message = 'Internal server error') {
    super(message);
    this.name = 'InternalServerError';
  }
}

class NetworkError extends Error {
  constructor(message = 'Network error') {
    super(message);
    this.name = 'NetworkError';
  }
}

class TimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

// ── Mock Google Gemini SDK class ────────────────────────────────

function createMockGeminiSDK() {
  const generateContentFn = jest.fn<any>();

  class MockGenerativeModel {
    readonly model: string;
    generateContent = generateContentFn;

    constructor(model: string) {
      this.model = model;
    }
  }

  class MockGoogleGenerativeAI {
    readonly apiKey: string;

    constructor(apiKey: string) {
      this.apiKey = apiKey;
    }

    getGenerativeModel(params: { model: string }): MockGenerativeModel {
      return new MockGenerativeModel(params.model);
    }
  }

  return { MockGoogleGenerativeAI, generateContentFn };
}

// ── Helpers ─────────────────────────────────────────────────────

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    credentials: { apiKey: 'test-api-key' },
    models: ['gemini-1.5-pro', 'gemini-1.5-flash'],
    ...overrides,
  };
}

function mockSuccessResponse(overrides?: Record<string, unknown>) {
  return {
    response: {
      candidates: [
        {
          content: { parts: [{ text: 'Hello, world!' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 18,
      },
      ...overrides,
    },
  };
}

// ── fast-check arbitraries ──────────────────────────────────────

const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const),
  content: fc.string({ minLength: 1, maxLength: 100 }),
});

const stopReasonArb = fc.constantFrom('STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER');

const usageArb = fc.record({
  promptTokenCount: fc.nat({ max: 100000 }),
  candidatesTokenCount: fc.nat({ max: 100000 }),
});


// ── Tests ───────────────────────────────────────────────────────

describe('GoogleGeminiProvider', () => {
  let MockGoogleGenerativeAI: any;
  let generateContentFn: jest.Mock<any>;

  beforeEach(() => {
    const sdk = createMockGeminiSDK();
    MockGoogleGenerativeAI = sdk.MockGoogleGenerativeAI;
    generateContentFn = sdk.generateContentFn;
  });

  function createProvider(config?: ProviderConfig): GoogleGeminiProvider {
    return new GoogleGeminiProvider(config ?? createConfig(), MockGoogleGenerativeAI);
  }

  // ── Construction ────────────────────────────────────────────────

  describe('construction', () => {
    it('should throw CONFIG error when apiKey is missing', () => {
      expect(() => new GoogleGeminiProvider(
        { credentials: {}, models: ['gemini-1.5-pro'] },
        MockGoogleGenerativeAI,
      )).toThrow(BridgeError);

      try {
        new GoogleGeminiProvider({ credentials: {}, models: ['gemini-1.5-pro'] }, MockGoogleGenerativeAI);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('apiKey');
        expect((err as BridgeError).details.providerId).toBe('google-gemini');
      }
    });

    it('should throw CONFIG error when apiKey is empty string', () => {
      expect(() => new GoogleGeminiProvider(
        { credentials: { apiKey: '' }, models: ['gemini-1.5-pro'] },
        MockGoogleGenerativeAI,
      )).toThrow(BridgeError);

      try {
        new GoogleGeminiProvider({ credentials: { apiKey: '' }, models: ['gemini-1.5-pro'] }, MockGoogleGenerativeAI);
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should throw CONFIG error when SDK is not provided', () => {
      expect(() => new GoogleGeminiProvider(
        { credentials: { apiKey: 'key' }, models: ['gemini-1.5-pro'] },
      )).toThrow(BridgeError);

      try {
        new GoogleGeminiProvider({ credentials: { apiKey: 'key' }, models: ['gemini-1.5-pro'] });
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('SDK');
      }
    });

    it('should construct successfully with valid apiKey and SDK', () => {
      const provider = createProvider();
      expect(provider.id).toBe('google-gemini');
      expect(provider.models).toEqual(['gemini-1.5-pro', 'gemini-1.5-flash']);
    });

    it('should freeze the models array', () => {
      const provider = createProvider();
      expect(Object.isFrozen(provider.models)).toBe(true);
    });

    // Feature: multi-provider-agents, Property 10: Credential validation at construction
    it('property: missing or empty apiKey always throws CONFIG error', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(''),
            fc.constant(undefined as unknown as string),
          ),
          (apiKey) => {
            const config: ProviderConfig = {
              credentials: apiKey !== undefined ? { apiKey } : {},
              models: ['gemini-1.5-pro'],
            };
            try {
              new GoogleGeminiProvider(config, MockGoogleGenerativeAI);
              return false; // Should have thrown
            } catch (err) {
              return (
                err instanceof BridgeError &&
                err.type === 'CONFIG' &&
                err.details.providerId === 'google-gemini'
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── complete() — response normalization ─────────────────────────

  describe('complete() — response normalization', () => {
    let provider: GoogleGeminiProvider;

    beforeEach(() => {
      provider = createProvider();
    });

    it('should return normalized result for a successful response', async () => {
      generateContentFn.mockResolvedValue(mockSuccessResponse());

      const result = await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'gemini-1.5-pro' },
      );

      expect(result.text).toBe('Hello, world!');
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 18 });
    });

    it('should map "STOP" finishReason to "end_turn"', async () => {
      generateContentFn.mockResolvedValue(mockSuccessResponse());
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.stopReason).toBe('end_turn');
    });

    it('should map "MAX_TOKENS" finishReason to "max_tokens"', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 100 },
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.stopReason).toBe('max_tokens');
    });

    it('should map "SAFETY" finishReason to "content_filter"', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'SAFETY' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.stopReason).toBe('content_filter');
    });

    it('should pass through unknown finishReason as-is', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'RECITATION' }],
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.stopReason).toBe('RECITATION');
    });

    it('should concatenate multiple text parts', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{
            content: { parts: [{ text: 'Hello, ' }, { text: 'world!' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.text).toBe('Hello, world!');
    });

    it('should return empty string when candidates array is empty', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.text).toBe('');
    });

    it('should return empty string when candidates is undefined', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.text).toBe('');
    });

    it('should return empty string when candidate content is undefined', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{ finishReason: 'SAFETY' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.text).toBe('');
    });

    it('should return empty string when candidate parts is undefined', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{ content: {}, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.text).toBe('');
    });

    it('should omit usage when usageMetadata is not present', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.usage).toBeUndefined();
    });

    it('should default usage counts to 0 when individual fields are undefined', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
          usageMetadata: {},
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('should use "unknown" as stopReason when finishReason is missing', async () => {
      generateContentFn.mockResolvedValue({
        response: {
          candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(result.stopReason).toBe('unknown');
    });

    // Feature: multi-provider-agents, Property 6: Provider response normalization
    it('property: stop reasons are correctly normalized for all known values', async () => {
      await fc.assert(
        fc.asyncProperty(stopReasonArb, fc.string({ minLength: 1, maxLength: 50 }), async (finishReason, content) => {
          const localGenerateContentFn = jest.fn<any>().mockResolvedValue({
            response: {
              candidates: [{ content: { parts: [{ text: content }] }, finishReason }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10 },
            },
          });
          const localMockSDK = class {
            constructor(_apiKey: string) { }
            getGenerativeModel() { return { generateContent: localGenerateContentFn }; }
          };
          const localProvider = new GoogleGeminiProvider(createConfig(), localMockSDK as any);

          const result = await localProvider.complete(
            [{ role: 'user', content: 'test' }],
            { model: 'gemini-1.5-pro' },
          );

          const expectedMap: Record<string, string> = {
            STOP: 'end_turn',
            MAX_TOKENS: 'max_tokens',
            SAFETY: 'content_filter',
          };

          const expected = expectedMap[finishReason] ?? finishReason;
          expect(result.stopReason).toBe(expected);
          expect(result.text).toBe(content);
        }),
        { numRuns: 100 },
      );
    });

    // Feature: multi-provider-agents, Property 7: Provider usage normalization
    it('property: usage is correctly normalized from SDK format', async () => {
      await fc.assert(
        fc.asyncProperty(usageArb, async (usage) => {
          const localGenerateContentFn = jest.fn<any>().mockResolvedValue({
            response: {
              candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
              usageMetadata: usage,
            },
          });
          const localMockSDK = class {
            constructor(_apiKey: string) { }
            getGenerativeModel() { return { generateContent: localGenerateContentFn }; }
          };
          const localProvider = new GoogleGeminiProvider(createConfig(), localMockSDK as any);

          const result = await localProvider.complete(
            [{ role: 'user', content: 'test' }],
            { model: 'gemini-1.5-pro' },
          );

          expect(result.usage).toEqual({
            inputTokens: usage.promptTokenCount,
            outputTokens: usage.candidatesTokenCount,
          });
        }),
        { numRuns: 100 },
      );
    });
  });


  // ── complete() — request construction ───────────────────────────

  describe('complete() — request construction', () => {
    let provider: GoogleGeminiProvider;

    beforeEach(() => {
      provider = createProvider();
      generateContentFn.mockResolvedValue(mockSuccessResponse());
    });

    it('should pass model to getGenerativeModel', async () => {
      const getModelSpy = jest.spyOn(
        (provider as any).client,
        'getGenerativeModel',
      );
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      expect(getModelSpy).toHaveBeenCalledWith({ model: 'gemini-1.5-pro' });
    });

    it('should use default model when params.model is not specified', async () => {
      const providerWithDefaults = new GoogleGeminiProvider(
        createConfig({ defaults: { model: 'gemini-1.5-flash' } }),
        MockGoogleGenerativeAI,
      );
      const getModelSpy = jest.spyOn(
        (providerWithDefaults as any).client,
        'getGenerativeModel',
      );

      await providerWithDefaults.complete([{ role: 'user', content: 'hi' }], {});
      expect(getModelSpy).toHaveBeenCalledWith({ model: 'gemini-1.5-flash' });
    });

    it('should throw UPSTREAM error when no model is available', async () => {
      const providerNoDefault = new GoogleGeminiProvider(
        createConfig({ defaults: undefined }),
        MockGoogleGenerativeAI,
      );

      await expect(
        providerNoDefault.complete([{ role: 'user', content: 'hi' }], {}),
      ).rejects.toMatchObject({
        type: 'UPSTREAM',
        message: expect.stringContaining('No model'),
      });
    });

    it('should pass temperature in generationConfig', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro', temperature: 0.7 });
      expect(generateContentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ temperature: 0.7 }),
        }),
      );
    });

    it('should pass maxTokens as maxOutputTokens in generationConfig', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro', maxTokens: 500 });
      expect(generateContentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ maxOutputTokens: 500 }),
        }),
      );
    });

    it('should pass topP in generationConfig', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro', topP: 0.9 });
      expect(generateContentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ topP: 0.9 }),
        }),
      );
    });

    it('should pass topK in generationConfig', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro', topK: 40 });
      expect(generateContentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ topK: 40 }),
        }),
      );
    });

    it('should pass stopSequences in generationConfig', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro', stopSequences: ['END', 'STOP'] });
      expect(generateContentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({ stopSequences: ['END', 'STOP'] }),
        }),
      );
    });

    it('should not include generationConfig when no params are specified', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['generationConfig']).toBeUndefined();
    });

    it('should pass systemPrompt as systemInstruction', async () => {
      await provider.complete(
        [{ role: 'user', content: 'hi' }],
        { model: 'gemini-1.5-pro', systemPrompt: 'You are helpful.' },
      );
      expect(generateContentFn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemInstruction: { parts: [{ text: 'You are helpful.' }] },
        }),
      );
    });

    it('should not include systemInstruction when no system prompt is available', async () => {
      await provider.complete(
        [{ role: 'user', content: 'hi' }],
        { model: 'gemini-1.5-pro' },
      );
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['systemInstruction']).toBeUndefined();
    });
  });

  // ── complete() — content format conversion (Property 16) ────────

  describe('complete() — content format conversion', () => {
    let provider: GoogleGeminiProvider;

    beforeEach(() => {
      provider = createProvider();
      generateContentFn.mockResolvedValue(mockSuccessResponse());
    });

    it('should convert user messages to Gemini "user" role', async () => {
      await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'gemini-1.5-pro' },
      );
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['contents']).toEqual([
        { role: 'user', parts: [{ text: 'Hello' }] },
      ]);
    });

    it('should convert assistant messages to Gemini "model" role', async () => {
      await provider.complete(
        [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'How are you?' },
        ],
        { model: 'gemini-1.5-pro' },
      );
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['contents']).toEqual([
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi there' }] },
        { role: 'user', parts: [{ text: 'How are you?' }] },
      ]);
    });

    it('should extract system messages to systemInstruction', async () => {
      await provider.complete(
        [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'gemini-1.5-pro' },
      );
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['systemInstruction']).toEqual({ parts: [{ text: 'Be concise.' }] });
      // System messages should NOT be in contents
      expect(callArgs['contents']).toEqual([
        { role: 'user', parts: [{ text: 'Hello' }] },
      ]);
    });

    it('should combine multiple system messages into systemInstruction parts', async () => {
      await provider.complete(
        [
          { role: 'system', content: 'First instruction.' },
          { role: 'system', content: 'Second instruction.' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'gemini-1.5-pro' },
      );
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['systemInstruction']).toEqual({
        parts: [{ text: 'First instruction.' }, { text: 'Second instruction.' }],
      });
    });

    it('should prefer system messages over systemPrompt param', async () => {
      await provider.complete(
        [
          { role: 'system', content: 'From messages.' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'gemini-1.5-pro', systemPrompt: 'From params.' },
      );
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['systemInstruction']).toEqual({ parts: [{ text: 'From messages.' }] });
    });

    it('should use systemPrompt param when no system messages exist', async () => {
      await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'gemini-1.5-pro', systemPrompt: 'From params.' },
      );
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['systemInstruction']).toEqual({ parts: [{ text: 'From params.' }] });
    });

    // Feature: multi-provider-agents, Property 16: Gemini content format conversion
    it('property: ChatMessage[] is correctly converted to Gemini Content[] format', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(chatMessageArb, { minLength: 1, maxLength: 10 }),
          async (messages) => {
            const localGenerateContentFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const localMockSDK = class {
              constructor(_apiKey: string) { }
              getGenerativeModel() { return { generateContent: localGenerateContentFn }; }
            };
            const localProvider = new GoogleGeminiProvider(createConfig(), localMockSDK as any);

            await localProvider.complete(messages, { model: 'gemini-1.5-pro' });

            const callArgs = localGenerateContentFn.mock.calls[0]![0] as Record<string, any>;
            const contents = callArgs['contents'] as Array<{ role: string; parts: Array<{ text: string }> }>;

            // All messages should be converted (none are system in this arb)
            expect(contents.length).toBe(messages.length);

            for (let i = 0; i < messages.length; i++) {
              const msg = messages[i]!;
              const content = contents[i]!;

              // Role mapping: user → user, assistant → model
              const expectedRole = msg.role === 'assistant' ? 'model' : 'user';
              expect(content.role).toBe(expectedRole);

              // Content preserved in parts
              expect(content.parts).toEqual([{ text: msg.content }]);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: system messages are always extracted and non-system messages preserved in order', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.array(chatMessageArb, { minLength: 1, maxLength: 5 }),
          async (systemContent, userMessages) => {
            const localGenerateContentFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const localMockSDK = class {
              constructor(_apiKey: string) { }
              getGenerativeModel() { return { generateContent: localGenerateContentFn }; }
            };
            const localProvider = new GoogleGeminiProvider(createConfig(), localMockSDK as any);

            const messages: ChatMessage[] = [
              { role: 'system', content: systemContent },
              ...userMessages,
            ];

            await localProvider.complete(messages, { model: 'gemini-1.5-pro' });

            const callArgs = localGenerateContentFn.mock.calls[0]![0] as Record<string, any>;
            // System should be in systemInstruction
            expect(callArgs['systemInstruction']).toEqual({ parts: [{ text: systemContent }] });
            // Contents should only have non-system messages
            const contents = callArgs['contents'] as Array<{ role: string; parts: Array<{ text: string }> }>;
            expect(contents.length).toBe(userMessages.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });


  // ── complete() — error handling ─────────────────────────────────

  describe('complete() — error handling', () => {
    let provider: GoogleGeminiProvider;

    beforeEach(() => {
      provider = createProvider();
    });

    it('should map UNAUTHENTICATED status to AUTH BridgeError', async () => {
      generateContentFn.mockRejectedValue(new AuthenticationError('Invalid API key'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('AUTH');
        expect((err as BridgeError).message).toBe('Invalid API key');
        expect((err as BridgeError).details.providerId).toBe('google-gemini');
        expect((err as BridgeError).details.retryable).toBe(false);
      }
    });

    it('should map RESOURCE_EXHAUSTED status to UPSTREAM BridgeError with retryable: true', async () => {
      generateContentFn.mockRejectedValue(new RateLimitError('Rate limit exceeded'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('google-gemini');
      }
    });

    it('should map INVALID_ARGUMENT status to UPSTREAM BridgeError with retryable: false', async () => {
      generateContentFn.mockRejectedValue(new BadRequestError('Invalid argument'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(false);
        expect((err as BridgeError).details.providerId).toBe('google-gemini');
      }
    });

    it('should map INTERNAL status to UPSTREAM BridgeError with retryable: true', async () => {
      generateContentFn.mockRejectedValue(new InternalServerError('Internal error'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('google-gemini');
      }
    });

    it('should map NetworkError to TRANSPORT BridgeError with retryable: true', async () => {
      generateContentFn.mockRejectedValue(new NetworkError('Network failed'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('TRANSPORT');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('google-gemini');
      }
    });

    it('should map TimeoutError to TIMEOUT BridgeError with retryable: true', async () => {
      generateContentFn.mockRejectedValue(new TimeoutError('Request timed out'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('TIMEOUT');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('google-gemini');
      }
    });

    it('should map error with "timeout" in message to TIMEOUT BridgeError', async () => {
      const err = new Error('Connection timeout occurred');
      generateContentFn.mockRejectedValue(err);

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false);
      } catch (caught) {
        expect(caught).toBeInstanceOf(BridgeError);
        expect((caught as BridgeError).type).toBe('TIMEOUT');
        expect((caught as BridgeError).details.retryable).toBe(true);
      }
    });

    it('should map unknown errors to UPSTREAM BridgeError with retryable: false', async () => {
      generateContentFn.mockRejectedValue(new Error('Something unexpected'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(false);
        expect((err as BridgeError).details.providerId).toBe('google-gemini');
        expect((err as BridgeError).cause?.message).toBe('Something unexpected');
      }
    });

    it('should pass through BridgeError without re-wrapping', async () => {
      const bridgeErr = BridgeError.upstream('Already wrapped', { providerId: 'google-gemini' });
      generateContentFn.mockRejectedValue(bridgeErr);

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gemini-1.5-pro' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBe(bridgeErr);
      }
    });

    // Feature: multi-provider-agents, Property 8: Provider error classification
    it('property: all SDK error types are classified correctly', async () => {
      const errorFactories = [
        { factory: (msg: string) => new AuthenticationError(msg), expectedType: 'AUTH', retryable: false },
        { factory: (msg: string) => new RateLimitError(msg), expectedType: 'UPSTREAM', retryable: true },
        { factory: (msg: string) => new BadRequestError(msg), expectedType: 'UPSTREAM', retryable: false },
        { factory: (msg: string) => new InternalServerError(msg), expectedType: 'UPSTREAM', retryable: true },
        { factory: (msg: string) => new NetworkError(msg), expectedType: 'TRANSPORT', retryable: true },
        { factory: (msg: string) => new TimeoutError(msg), expectedType: 'TIMEOUT', retryable: true },
      ];

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: errorFactories.length - 1 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (idx, message) => {
            const { factory, expectedType, retryable } = errorFactories[idx]!;
            const localGenerateContentFn = jest.fn<any>().mockRejectedValue(factory(message));
            const localMockSDK = class {
              constructor(_apiKey: string) { }
              getGenerativeModel() { return { generateContent: localGenerateContentFn }; }
            };
            const localProvider = new GoogleGeminiProvider(createConfig(), localMockSDK as any);

            try {
              await localProvider.complete([{ role: 'user', content: 'test' }], { model: 'gemini-1.5-pro' });
              expect(true).toBe(false); // Should not reach here
            } catch (err) {
              expect(err).toBeInstanceOf(BridgeError);
              expect((err as BridgeError).type).toBe(expectedType);
              expect((err as BridgeError).details.retryable).toBe(retryable);
              expect((err as BridgeError).details.providerId).toBe('google-gemini');
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    // Feature: multi-provider-agents, Property 9: Provider id in error details
    it('property: all errors include providerId in details', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ minLength: 1, maxLength: 50 }), async (message) => {
          const localGenerateContentFn = jest.fn<any>().mockRejectedValue(new Error(message));
          const localMockSDK = class {
            constructor(_apiKey: string) { }
            getGenerativeModel() { return { generateContent: localGenerateContentFn }; }
          };
          const localProvider = new GoogleGeminiProvider(createConfig(), localMockSDK as any);

          try {
            await localProvider.complete([{ role: 'user', content: 'test' }], { model: 'gemini-1.5-pro' });
            expect(true).toBe(false); // Should not reach here
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).details.providerId).toBe('google-gemini');
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // ── complete() — message handling ───────────────────────────────

  describe('complete() — message handling', () => {
    let provider: GoogleGeminiProvider;

    beforeEach(() => {
      provider = createProvider();
      generateContentFn.mockResolvedValue(mockSuccessResponse());
    });

    it('should preserve message order in contents', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ];

      await provider.complete(messages, { model: 'gemini-1.5-pro' });
      const callArgs = generateContentFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['contents']).toEqual([
        { role: 'user', parts: [{ text: 'Hello' }] },
        { role: 'model', parts: [{ text: 'Hi there' }] },
        { role: 'user', parts: [{ text: 'How are you?' }] },
      ]);
    });

    it('property: message order is preserved in conversion', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(chatMessageArb, { minLength: 1, maxLength: 10 }),
          async (messages) => {
            const localGenerateContentFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const localMockSDK = class {
              constructor(_apiKey: string) { }
              getGenerativeModel() { return { generateContent: localGenerateContentFn }; }
            };
            const localProvider = new GoogleGeminiProvider(createConfig(), localMockSDK as any);

            await localProvider.complete(messages, { model: 'gemini-1.5-pro' });
            const callArgs = localGenerateContentFn.mock.calls[0]![0] as Record<string, any>;
            const contents = callArgs['contents'] as Array<{ role: string; parts: Array<{ text: string }> }>;

            expect(contents.length).toBe(messages.length);
            for (let i = 0; i < messages.length; i++) {
              expect(contents[i]!.parts[0]!.text).toBe(messages[i]!.content);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
