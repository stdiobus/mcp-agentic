/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit and property-based tests for OpenAIProvider.
 *
 * Tests cover:
 * - Credential validation at construction (Property 10)
 * - Response normalization (Property 6)
 * - Usage normalization (Property 7)
 * - Error classification (Property 8)
 * - Provider id in error details (Property 9)
 * - Unsupported providerSpecific ignored (Property 11)
 * - AbortSignal passthrough
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import { OpenAIProvider } from '../../../../src/provider/providers/OpenAIProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import type { ChatMessage, ProviderConfig, RuntimeParams } from '../../../../src/provider/AIProvider.js';

// ── Mock SDK error classes (local to test) ──────────────────────

class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Incorrect API key provided') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

class RateLimitError extends Error {
  readonly status = 429;
  constructor(message = 'Rate limit exceeded') {
    super(message);
    this.name = 'RateLimitError';
  }
}

class APIConnectionError extends Error {
  constructor(message = 'Connection error') {
    super(message);
    this.name = 'APIConnectionError';
  }
}

class APITimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'APITimeoutError';
  }
}

class BadRequestError extends Error {
  readonly status = 400;
  constructor(message = 'Bad request') {
    super(message);
    this.name = 'BadRequestError';
  }
}

class InternalServerError extends Error {
  readonly status = 500;
  constructor(message = 'Internal server error') {
    super(message);
    this.name = 'InternalServerError';
  }
}

// ── Mock OpenAI SDK class ───────────────────────────────────────

function createMockOpenAISDK() {
  const createFn = jest.fn<any>();

  class MockOpenAI {
    readonly apiKey: string;
    readonly chat = {
      completions: {
        create: createFn,
      },
    };

    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
  }

  return { MockOpenAI, createFn };
}

// ── Helpers ─────────────────────────────────────────────────────

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    credentials: { apiKey: 'test-api-key' },
    models: ['gpt-4', 'gpt-3.5-turbo'],
    ...overrides,
  };
}

function mockSuccessResponse(overrides?: Record<string, unknown>) {
  return {
    choices: [
      {
        message: { content: 'Hello, world!' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
    },
    ...overrides,
  };
}

// ── fast-check arbitraries ──────────────────────────────────────

const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const),
  content: fc.string({ minLength: 1, maxLength: 100 }),
});

const stopReasonArb = fc.constantFrom('stop', 'length', 'content_filter', 'function_call', 'tool_calls');

const usageArb = fc.record({
  prompt_tokens: fc.nat({ max: 100000 }),
  completion_tokens: fc.nat({ max: 100000 }),
});

// ── Tests ───────────────────────────────────────────────────────

describe('OpenAIProvider', () => {
  let MockOpenAI: any;
  let createFn: jest.Mock<any>;

  beforeEach(() => {
    const sdk = createMockOpenAISDK();
    MockOpenAI = sdk.MockOpenAI;
    createFn = sdk.createFn;
  });

  function createProvider(config?: ProviderConfig): OpenAIProvider {
    return new OpenAIProvider(config ?? createConfig(), MockOpenAI);
  }

  // ── Construction ────────────────────────────────────────────────

  describe('construction', () => {
    it('should throw CONFIG error when apiKey is missing', () => {
      expect(() => new OpenAIProvider(
        { credentials: {}, models: ['gpt-4'] },
        MockOpenAI,
      )).toThrow(BridgeError);

      try {
        new OpenAIProvider({ credentials: {}, models: ['gpt-4'] }, MockOpenAI);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('apiKey');
        expect((err as BridgeError).details.providerId).toBe('openai');
      }
    });

    it('should throw CONFIG error when apiKey is empty string', () => {
      expect(() => new OpenAIProvider(
        { credentials: { apiKey: '' }, models: ['gpt-4'] },
        MockOpenAI,
      )).toThrow(BridgeError);

      try {
        new OpenAIProvider({ credentials: { apiKey: '' }, models: ['gpt-4'] }, MockOpenAI);
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should construct successfully with valid apiKey', () => {
      const provider = createProvider();
      expect(provider.id).toBe('openai');
      expect(provider.models).toEqual(['gpt-4', 'gpt-3.5-turbo']);
    });

    it('should freeze the models array', () => {
      const provider = createProvider();
      expect(Object.isFrozen(provider.models)).toBe(true);
    });

    // Feature: multi-provider-agents, Property 10: Credential validation at construction
    it('property: missing or empty apiKey always throws CONFIG error', () => {
      fc.assert(  // sync property — no await needed
        fc.property(
          fc.oneof(
            fc.constant(''),
            fc.constant(undefined as unknown as string),
          ),
          (apiKey) => {
            const config: ProviderConfig = {
              credentials: apiKey !== undefined ? { apiKey } : {},
              models: ['gpt-4'],
            };
            try {
              new OpenAIProvider(config, MockOpenAI);
              return false; // Should have thrown
            } catch (err) {
              return (
                err instanceof BridgeError &&
                err.type === 'CONFIG' &&
                err.details.providerId === 'openai'
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
    let provider: OpenAIProvider;

    beforeEach(() => {
      provider = createProvider();
    });

    it('should return normalized result for a successful response', async () => {
      createFn.mockResolvedValue(mockSuccessResponse());

      const result = await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'gpt-4' },
      );

      expect(result.text).toBe('Hello, world!');
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    });

    it('should map "stop" finish_reason to "end_turn"', async () => {
      createFn.mockResolvedValue({
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
      expect(result.stopReason).toBe('end_turn');
    });

    it('should map "length" finish_reason to "max_tokens"', async () => {
      createFn.mockResolvedValue({
        choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
      expect(result.stopReason).toBe('max_tokens');
    });

    it('should map "content_filter" finish_reason to "content_filter"', async () => {
      createFn.mockResolvedValue({
        choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
      expect(result.stopReason).toBe('content_filter');
    });

    it('should pass through unknown finish_reason as-is', async () => {
      createFn.mockResolvedValue({
        choices: [{ message: { content: 'x' }, finish_reason: 'tool_calls' }],
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
      expect(result.stopReason).toBe('tool_calls');
    });

    it('should return empty string when message content is null', async () => {
      createFn.mockResolvedValue({
        choices: [{ message: { content: null }, finish_reason: 'stop' }],
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
      expect(result.text).toBe('');
    });

    it('should return empty string when choices array is empty', async () => {
      createFn.mockResolvedValue({ choices: [] });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
      expect(result.text).toBe('');
    });

    it('should omit usage when SDK response has no usage field', async () => {
      createFn.mockResolvedValue({
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
      expect(result.usage).toBeUndefined();
    });

    // Feature: multi-provider-agents, Property 6: Provider response normalization
    it('property: stop reasons are correctly normalized for all known values', async () => {
      await fc.assert(
        fc.asyncProperty(stopReasonArb, fc.string({ minLength: 1, maxLength: 50 }), async (finishReason, content) => {
          const localCreateFn = jest.fn<any>().mockResolvedValue({
            choices: [{ message: { content }, finish_reason: finishReason }],
          });
          const localMockOpenAI = class {
            readonly chat = { completions: { create: localCreateFn } };
            constructor(_opts: { apiKey: string }) { }
          };
          const localProvider = new OpenAIProvider(createConfig(), localMockOpenAI as any);

          const result = await localProvider.complete(
            [{ role: 'user', content: 'test' }],
            { model: 'gpt-4' },
          );

          const expectedMap: Record<string, string> = {
            stop: 'end_turn',
            length: 'max_tokens',
            content_filter: 'content_filter',
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
          const localCreateFn = jest.fn<any>().mockResolvedValue({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage,
          });
          const localMockOpenAI = class {
            readonly chat = { completions: { create: localCreateFn } };
            constructor(_opts: { apiKey: string }) { }
          };
          const localProvider = new OpenAIProvider(createConfig(), localMockOpenAI as any);

          const result = await localProvider.complete(
            [{ role: 'user', content: 'test' }],
            { model: 'gpt-4' },
          );

          expect(result.usage).toEqual({
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
          });
        }),
        { numRuns: 100 },
      );
    });
  });

  // ── complete() — request construction ───────────────────────────

  describe('complete() — request construction', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
      provider = createProvider();
      createFn.mockResolvedValue(mockSuccessResponse());
    });

    it('should pass model to the SDK', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4' }),
        expect.anything(),
      );
    });

    it('should use default model when params.model is not specified', async () => {
      const providerWithDefaults = new OpenAIProvider(
        createConfig({ defaults: { model: 'gpt-3.5-turbo' } }),
        MockOpenAI,
      );

      await providerWithDefaults.complete([{ role: 'user', content: 'hi' }], {});
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-3.5-turbo' }),
        expect.anything(),
      );
    });

    it('should throw UPSTREAM error when no model is available', async () => {
      const providerNoDefault = new OpenAIProvider(
        createConfig({ defaults: undefined }),
        MockOpenAI,
      );

      await expect(
        providerNoDefault.complete([{ role: 'user', content: 'hi' }], {}),
      ).rejects.toMatchObject({
        type: 'UPSTREAM',
        message: expect.stringContaining('No model'),
      });
    });

    it('should pass temperature when specified', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4', temperature: 0.7 });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.7 }),
        expect.anything(),
      );
    });

    it('should pass maxTokens as max_tokens', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4', maxTokens: 100 });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 100 }),
        expect.anything(),
      );
    });

    it('should pass topP as top_p', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4', topP: 0.9 });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ top_p: 0.9 }),
        expect.anything(),
      );
    });

    it('should pass stopSequences as stop', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4', stopSequences: ['END'] });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ stop: ['END'] }),
        expect.anything(),
      );
    });

    it('should prepend systemPrompt as system message when not present', async () => {
      await provider.complete(
        [{ role: 'user', content: 'hi' }],
        { model: 'gpt-4', systemPrompt: 'You are helpful.' },
      );
      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['messages'][0]).toEqual({ role: 'system', content: 'You are helpful.' });
      expect(callArgs['messages'][1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('should not duplicate system message if already present', async () => {
      await provider.complete(
        [
          { role: 'system', content: 'Existing system prompt' },
          { role: 'user', content: 'hi' },
        ],
        { model: 'gpt-4', systemPrompt: 'New system prompt' },
      );
      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      // Should keep existing system message, not prepend another
      const systemMessages = (callArgs['messages'] as any[]).filter((m: any) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0].content).toBe('Existing system prompt');
    });

    it('should pass AbortSignal to the SDK call', async () => {
      const controller = new AbortController();
      await provider.complete(
        [{ role: 'user', content: 'hi' }],
        { model: 'gpt-4' },
        controller.signal,
      );
      expect(createFn).toHaveBeenCalledWith(
        expect.anything(),
        { signal: controller.signal },
      );
    });

    // Feature: multi-provider-agents, Property 11: Unsupported providerSpecific parameters are ignored
    it('should pass providerSpecific entries to the SDK request body', async () => {
      await provider.complete(
        [{ role: 'user', content: 'hi' }],
        {
          model: 'gpt-4',
          providerSpecific: { frequency_penalty: 0.5, presence_penalty: 0.3, custom_unknown: 'value' },
        },
      );
      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['frequency_penalty']).toBe(0.5);
      expect(callArgs['presence_penalty']).toBe(0.3);
      expect(callArgs['custom_unknown']).toBe('value');
    });

    it('property: providerSpecific keys are spread into request body', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(
            fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/).filter(
              (s) => !['model', 'messages', 'temperature', 'max_tokens', 'top_p', 'stop'].includes(s),
            ),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
            { minKeys: 1, maxKeys: 5 },
          ),
          async (providerSpecific) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const localMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const localProvider = new OpenAIProvider(createConfig(), localMockOpenAI as any);

            await localProvider.complete(
              [{ role: 'user', content: 'test' }],
              { model: 'gpt-4', providerSpecific },
            );

            const callArgs = localCreateFn.mock.calls[0]![0] as Record<string, any>;
            for (const [key, value] of Object.entries(providerSpecific)) {
              expect(callArgs[key]).toBe(value);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── complete() — error handling ─────────────────────────────────

  describe('complete() — error handling', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
      provider = createProvider();
    });

    it('should map AuthenticationError to AUTH BridgeError', async () => {
      createFn.mockRejectedValue(new AuthenticationError('Invalid API key'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('AUTH');
        expect((err as BridgeError).message).toBe('Invalid API key');
        expect((err as BridgeError).details.providerId).toBe('openai');
        expect((err as BridgeError).details.retryable).toBe(false);
      }
    });

    it('should map RateLimitError to UPSTREAM BridgeError with retryable: true', async () => {
      createFn.mockRejectedValue(new RateLimitError('Rate limit exceeded'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('openai');
      }
    });

    it('should map APIConnectionError to TRANSPORT BridgeError with retryable: true', async () => {
      createFn.mockRejectedValue(new APIConnectionError('Connection failed'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('TRANSPORT');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('openai');
      }
    });

    it('should map APITimeoutError to TIMEOUT BridgeError with retryable: true', async () => {
      createFn.mockRejectedValue(new APITimeoutError('Request timed out'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('TIMEOUT');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('openai');
      }
    });

    it('should map BadRequestError to UPSTREAM BridgeError with retryable: false', async () => {
      createFn.mockRejectedValue(new BadRequestError('Invalid model'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(false);
        expect((err as BridgeError).details.providerId).toBe('openai');
      }
    });

    it('should map InternalServerError to UPSTREAM BridgeError with retryable: true', async () => {
      createFn.mockRejectedValue(new InternalServerError('Server error'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('openai');
      }
    });

    it('should map unknown errors to UPSTREAM BridgeError', async () => {
      createFn.mockRejectedValue(new Error('Something unexpected'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(false);
        expect((err as BridgeError).details.providerId).toBe('openai');
        expect((err as BridgeError).cause?.message).toBe('Something unexpected');
      }
    });

    // Feature: multi-provider-agents, Property 8: Provider error classification
    it('property: all SDK error types are classified correctly', async () => {
      const errorFactories = [
        { factory: (msg: string) => new AuthenticationError(msg), expectedType: 'AUTH', retryable: false },
        { factory: (msg: string) => new RateLimitError(msg), expectedType: 'UPSTREAM', retryable: true },
        { factory: (msg: string) => new APIConnectionError(msg), expectedType: 'TRANSPORT', retryable: true },
        { factory: (msg: string) => new APITimeoutError(msg), expectedType: 'TIMEOUT', retryable: true },
        { factory: (msg: string) => new BadRequestError(msg), expectedType: 'UPSTREAM', retryable: false },
        { factory: (msg: string) => new InternalServerError(msg), expectedType: 'UPSTREAM', retryable: true },
      ];

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: errorFactories.length - 1 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          async (idx, message) => {
            const { factory, expectedType, retryable } = errorFactories[idx]!;
            const localCreateFn = jest.fn<any>().mockRejectedValue(factory(message));
            const localMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const localProvider = new OpenAIProvider(createConfig(), localMockOpenAI as any);

            try {
              await localProvider.complete([{ role: 'user', content: 'test' }], { model: 'gpt-4' });
              expect(true).toBe(false); // Should not reach here
            } catch (err) {
              expect(err).toBeInstanceOf(BridgeError);
              expect((err as BridgeError).type).toBe(expectedType);
              expect((err as BridgeError).details.retryable).toBe(retryable);
              expect((err as BridgeError).details.providerId).toBe('openai');
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
          const localCreateFn = jest.fn<any>().mockRejectedValue(new Error(message));
          const localMockOpenAI = class {
            readonly chat = { completions: { create: localCreateFn } };
            constructor(_opts: { apiKey: string }) { }
          };
          const localProvider = new OpenAIProvider(createConfig(), localMockOpenAI as any);

          try {
            await localProvider.complete([{ role: 'user', content: 'test' }], { model: 'gpt-4' });
            expect(true).toBe(false); // Should not reach here
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).details.providerId).toBe('openai');
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // ── complete() — message handling ───────────────────────────────

  describe('complete() — message handling', () => {
    let provider: OpenAIProvider;

    beforeEach(() => {
      provider = createProvider();
      createFn.mockResolvedValue(mockSuccessResponse());
    });

    it('should pass all messages to the SDK in order', async () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ];

      await provider.complete(messages, { model: 'gpt-4' });
      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['messages']).toEqual(messages.map((m) => ({ role: m.role, content: m.content })));
    });

    it('property: message order is preserved', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(chatMessageArb, { minLength: 1, maxLength: 10 }),
          async (messages) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const localMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const localProvider = new OpenAIProvider(createConfig(), localMockOpenAI as any);

            await localProvider.complete(messages, { model: 'gpt-4' });
            const callArgs = localCreateFn.mock.calls[0]![0] as Record<string, any>;
            const sentMessages = callArgs['messages'] as Array<{ role: string; content: string }>;

            // Messages should be in the same order (no systemPrompt param, so no prepend)
            for (let i = 0; i < messages.length; i++) {
              expect(sentMessages[i]!.role).toBe(messages[i]!.role);
              expect(sentMessages[i]!.content).toBe(messages[i]!.content);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
