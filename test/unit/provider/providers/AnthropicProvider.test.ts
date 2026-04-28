/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit and property-based tests for AnthropicProvider.
 *
 * Tests cover:
 * - Credential validation at construction (Property 10)
 * - Response normalization (Property 6)
 * - Usage normalization (Property 7)
 * - Error classification (Property 8)
 * - Provider id in error details (Property 9)
 * - Unsupported providerSpecific ignored (Property 11)
 * - Anthropic system prompt extraction (Property 15)
 * - AbortSignal passthrough
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import { AnthropicProvider } from '../../../../src/provider/providers/AnthropicProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import type { ChatMessage, ProviderConfig, RuntimeParams } from '../../../../src/provider/AIProvider.js';

// ── Mock SDK error classes (local to test) ──────────────────────

class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Invalid API key') {
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

class APIConnectionTimeoutError extends Error {
  constructor(message = 'Connection timed out') {
    super(message);
    this.name = 'APIConnectionTimeoutError';
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

// ── Mock Anthropic SDK class ────────────────────────────────────

function createMockAnthropicSDK() {
  const createFn = jest.fn<any>();

  class MockAnthropic {
    readonly apiKey: string;
    readonly messages = {
      create: createFn,
    };

    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
  }

  return { MockAnthropic, createFn };
}

// ── Helpers ─────────────────────────────────────────────────────

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    credentials: { apiKey: 'test-api-key' },
    models: ['claude-sonnet-4-20250514', 'claude-3-haiku-20240307'],
    ...overrides,
  };
}

function mockSuccessResponse(overrides?: Record<string, unknown>) {
  return {
    content: [
      { type: 'text', text: 'Hello, world!' },
    ],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 15,
      output_tokens: 25,
    },
    ...overrides,
  };
}

// ── fast-check arbitraries ──────────────────────────────────────

const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const),
  content: fc.string({ minLength: 1, maxLength: 100 }),
});

const stopReasonArb = fc.constantFrom('end_turn', 'max_tokens', 'stop_sequence', 'tool_use');

const usageArb = fc.record({
  input_tokens: fc.nat({ max: 100000 }),
  output_tokens: fc.nat({ max: 100000 }),
});


// ── Tests ───────────────────────────────────────────────────────

describe('AnthropicProvider', () => {
  let MockAnthropic: any;
  let createFn: jest.Mock<any>;

  beforeEach(() => {
    const sdk = createMockAnthropicSDK();
    MockAnthropic = sdk.MockAnthropic;
    createFn = sdk.createFn;
  });

  function createProvider(config?: ProviderConfig): AnthropicProvider {
    return new AnthropicProvider(config ?? createConfig(), MockAnthropic);
  }

  // ── Construction ────────────────────────────────────────────────

  describe('construction', () => {
    it('should throw CONFIG error when apiKey is missing', () => {
      expect(() => new AnthropicProvider(
        { credentials: {}, models: ['claude-sonnet-4-20250514'] },
        MockAnthropic,
      )).toThrow(BridgeError);

      try {
        new AnthropicProvider({ credentials: {}, models: ['claude-sonnet-4-20250514'] }, MockAnthropic);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('CONFIG');
        expect((err as BridgeError).message).toContain('apiKey');
        expect((err as BridgeError).details.providerId).toBe('anthropic');
      }
    });

    it('should throw CONFIG error when apiKey is empty string', () => {
      expect(() => new AnthropicProvider(
        { credentials: { apiKey: '' }, models: ['claude-sonnet-4-20250514'] },
        MockAnthropic,
      )).toThrow(BridgeError);

      try {
        new AnthropicProvider({ credentials: { apiKey: '' }, models: ['claude-sonnet-4-20250514'] }, MockAnthropic);
      } catch (err) {
        expect((err as BridgeError).type).toBe('CONFIG');
      }
    });

    it('should construct successfully with valid apiKey', () => {
      const provider = createProvider();
      expect(provider.id).toBe('anthropic');
      expect(provider.models).toEqual(['claude-sonnet-4-20250514', 'claude-3-haiku-20240307']);
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
              models: ['claude-sonnet-4-20250514'],
            };
            try {
              new AnthropicProvider(config, MockAnthropic);
              return false; // Should have thrown
            } catch (err) {
              return (
                err instanceof BridgeError &&
                err.type === 'CONFIG' &&
                err.details.providerId === 'anthropic'
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
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = createProvider();
    });

    it('should return normalized result for a successful response', async () => {
      createFn.mockResolvedValue(mockSuccessResponse());

      const result = await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'claude-sonnet-4-20250514' },
      );

      expect(result.text).toBe('Hello, world!');
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 25 });
    });

    it('should map "end_turn" stop_reason to "end_turn"', async () => {
      createFn.mockResolvedValue(mockSuccessResponse({ stop_reason: 'end_turn' }));
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(result.stopReason).toBe('end_turn');
    });

    it('should map "max_tokens" stop_reason to "max_tokens"', async () => {
      createFn.mockResolvedValue(mockSuccessResponse({ stop_reason: 'max_tokens' }));
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(result.stopReason).toBe('max_tokens');
    });

    it('should pass through unknown stop_reason as-is', async () => {
      createFn.mockResolvedValue(mockSuccessResponse({ stop_reason: 'tool_use' }));
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(result.stopReason).toBe('tool_use');
    });

    it('should concatenate multiple text content blocks', async () => {
      createFn.mockResolvedValue({
        content: [
          { type: 'text', text: 'Hello, ' },
          { type: 'text', text: 'world!' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(result.text).toBe('Hello, world!');
    });

    it('should ignore non-text content blocks', async () => {
      createFn.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'search', input: {} },
          { type: 'text', text: 'Result here' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(result.text).toBe('Result here');
    });

    it('should return empty string when no text content blocks exist', async () => {
      createFn.mockResolvedValue({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'search', input: {} },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(result.text).toBe('');
    });

    it('should return empty string when content array is empty', async () => {
      createFn.mockResolvedValue({
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(result.text).toBe('');
    });

    it('should omit usage when SDK response has no usage field', async () => {
      createFn.mockResolvedValue({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
      });
      const result = await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(result.usage).toBeUndefined();
    });

    // Feature: multi-provider-agents, Property 6: Provider response normalization
    it('property: stop reasons are correctly normalized for all known values', async () => {
      await fc.assert(
        fc.asyncProperty(stopReasonArb, fc.string({ minLength: 1, maxLength: 50 }), async (stopReason, content) => {
          const localCreateFn = jest.fn<any>().mockResolvedValue({
            content: [{ type: 'text', text: content }],
            stop_reason: stopReason,
            usage: { input_tokens: 10, output_tokens: 5 },
          });
          const localMockAnthropic = class {
            readonly messages = { create: localCreateFn };
            constructor(_opts: { apiKey: string }) { }
          };
          const localProvider = new AnthropicProvider(createConfig(), localMockAnthropic as any);

          const result = await localProvider.complete(
            [{ role: 'user', content: 'test' }],
            { model: 'claude-sonnet-4-20250514' },
          );

          const expectedMap: Record<string, string> = {
            end_turn: 'end_turn',
            max_tokens: 'max_tokens',
          };

          const expected = expectedMap[stopReason] ?? stopReason;
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
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage,
          });
          const localMockAnthropic = class {
            readonly messages = { create: localCreateFn };
            constructor(_opts: { apiKey: string }) { }
          };
          const localProvider = new AnthropicProvider(createConfig(), localMockAnthropic as any);

          const result = await localProvider.complete(
            [{ role: 'user', content: 'test' }],
            { model: 'claude-sonnet-4-20250514' },
          );

          expect(result.usage).toEqual({
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          });
        }),
        { numRuns: 100 },
      );
    });
  });


  // ── complete() — request construction ───────────────────────────

  describe('complete() — request construction', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = createProvider();
      createFn.mockResolvedValue(mockSuccessResponse());
    });

    it('should pass model to the SDK', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet-4-20250514' }),
        expect.anything(),
      );
    });

    it('should use default model when params.model is not specified', async () => {
      const providerWithDefaults = new AnthropicProvider(
        createConfig({ defaults: { model: 'claude-3-haiku-20240307' } }),
        MockAnthropic,
      );

      await providerWithDefaults.complete([{ role: 'user', content: 'hi' }], {});
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-3-haiku-20240307' }),
        expect.anything(),
      );
    });

    it('should throw UPSTREAM error when no model is available', async () => {
      const providerNoDefault = new AnthropicProvider(
        createConfig({ defaults: undefined }),
        MockAnthropic,
      );

      await expect(
        providerNoDefault.complete([{ role: 'user', content: 'hi' }], {}),
      ).rejects.toMatchObject({
        type: 'UPSTREAM',
        message: expect.stringContaining('No model'),
      });
    });

    it('should pass temperature when specified', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514', temperature: 0.7 });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.7 }),
        expect.anything(),
      );
    });

    it('should pass maxTokens as max_tokens', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514', maxTokens: 2048 });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 2048 }),
        expect.anything(),
      );
    });

    it('should use default max_tokens of 1024 when not specified', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 1024 }),
        expect.anything(),
      );
    });

    it('should pass topP as top_p', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514', topP: 0.9 });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ top_p: 0.9 }),
        expect.anything(),
      );
    });

    it('should pass topK as top_k', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514', topK: 40 });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ top_k: 40 }),
        expect.anything(),
      );
    });

    it('should pass stopSequences as stop_sequences', async () => {
      await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514', stopSequences: ['END', 'STOP'] });
      expect(createFn).toHaveBeenCalledWith(
        expect.objectContaining({ stop_sequences: ['END', 'STOP'] }),
        expect.anything(),
      );
    });

    it('should pass AbortSignal to the SDK call', async () => {
      const controller = new AbortController();
      await provider.complete(
        [{ role: 'user', content: 'hi' }],
        { model: 'claude-sonnet-4-20250514' },
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
          model: 'claude-sonnet-4-20250514',
          providerSpecific: { metadata: { user_id: '123' }, custom_unknown: 'value' },
        },
      );
      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['metadata']).toEqual({ user_id: '123' });
      expect(callArgs['custom_unknown']).toBe('value');
    });

    it('property: providerSpecific keys are spread into request body', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(
            fc.stringMatching(/^[a-z][a-z0-9_]{0,19}$/).filter(
              (s) => !['model', 'messages', 'system', 'max_tokens', 'temperature', 'top_p', 'top_k', 'stop_sequences'].includes(s),
            ),
            fc.oneof(fc.string(), fc.integer(), fc.boolean()),
            { minKeys: 1, maxKeys: 5 },
          ),
          async (providerSpecific) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const localMockAnthropic = class {
              readonly messages = { create: localCreateFn };
              constructor(_opts: { apiKey: string }) { }
            };
            const localProvider = new AnthropicProvider(createConfig(), localMockAnthropic as any);

            await localProvider.complete(
              [{ role: 'user', content: 'test' }],
              { model: 'claude-sonnet-4-20250514', providerSpecific },
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

  // ── complete() — system prompt extraction (Property 15) ─────────

  describe('complete() — system prompt extraction', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = createProvider();
      createFn.mockResolvedValue(mockSuccessResponse());
    });

    it('should extract system message to top-level system parameter', async () => {
      await provider.complete(
        [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'claude-sonnet-4-20250514' },
      );

      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['system']).toBe('You are helpful.');
      // System message should NOT be in the messages array
      const messages = callArgs['messages'] as Array<{ role: string; content: string }>;
      expect(messages.every((m: any) => m.role !== 'system')).toBe(true);
      expect(messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('should use systemPrompt param when no system message in array', async () => {
      await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'claude-sonnet-4-20250514', systemPrompt: 'Be concise.' },
      );

      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['system']).toBe('Be concise.');
    });

    it('should prefer system messages in array over systemPrompt param', async () => {
      await provider.complete(
        [
          { role: 'system', content: 'From messages array.' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'claude-sonnet-4-20250514', systemPrompt: 'From params.' },
      );

      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['system']).toBe('From messages array.');
    });

    it('should concatenate multiple system messages', async () => {
      await provider.complete(
        [
          { role: 'system', content: 'First instruction.' },
          { role: 'system', content: 'Second instruction.' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'claude-sonnet-4-20250514' },
      );

      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['system']).toBe('First instruction.\n\nSecond instruction.');
    });

    it('should not include system field when no system prompt is available', async () => {
      await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'claude-sonnet-4-20250514' },
      );

      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['system']).toBeUndefined();
    });

    // Feature: multi-provider-agents, Property 15: Anthropic system prompt extraction
    it('property: system messages are always extracted to top-level and excluded from messages array', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.array(chatMessageArb, { minLength: 1, maxLength: 5 }),
          async (systemContent, userMessages) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const localMockAnthropic = class {
              readonly messages = { create: localCreateFn };
              constructor(_opts: { apiKey: string }) { }
            };
            const localProvider = new AnthropicProvider(createConfig(), localMockAnthropic as any);

            const messages: ChatMessage[] = [
              { role: 'system', content: systemContent },
              ...userMessages,
            ];

            await localProvider.complete(messages, { model: 'claude-sonnet-4-20250514' });

            const callArgs = localCreateFn.mock.calls[0]![0] as Record<string, any>;
            // System prompt should be at top level
            expect(callArgs['system']).toBe(systemContent);
            // Messages array should not contain system messages
            const sentMessages = callArgs['messages'] as Array<{ role: string; content: string }>;
            expect(sentMessages.every((m: any) => m.role !== 'system')).toBe(true);
            // All non-system messages should be preserved
            expect(sentMessages.length).toBe(userMessages.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });


  // ── complete() — error handling ─────────────────────────────────

  describe('complete() — error handling', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = createProvider();
    });

    it('should map AuthenticationError to AUTH BridgeError', async () => {
      createFn.mockRejectedValue(new AuthenticationError('Invalid API key'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
        expect(true).toBe(false); // Should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('AUTH');
        expect((err as BridgeError).message).toBe('Invalid API key');
        expect((err as BridgeError).details.providerId).toBe('anthropic');
        expect((err as BridgeError).details.retryable).toBe(false);
      }
    });

    it('should map RateLimitError to UPSTREAM BridgeError with retryable: true', async () => {
      createFn.mockRejectedValue(new RateLimitError('Rate limit exceeded'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('anthropic');
      }
    });

    it('should map APIConnectionError to TRANSPORT BridgeError with retryable: true', async () => {
      createFn.mockRejectedValue(new APIConnectionError('Connection failed'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('TRANSPORT');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('anthropic');
      }
    });

    it('should map APIConnectionTimeoutError to TIMEOUT BridgeError with retryable: true', async () => {
      createFn.mockRejectedValue(new APIConnectionTimeoutError('Connection timed out'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('TIMEOUT');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('anthropic');
      }
    });

    it('should map BadRequestError to UPSTREAM BridgeError with retryable: false', async () => {
      createFn.mockRejectedValue(new BadRequestError('Invalid model'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(false);
        expect((err as BridgeError).details.providerId).toBe('anthropic');
      }
    });

    it('should map InternalServerError to UPSTREAM BridgeError with retryable: true', async () => {
      createFn.mockRejectedValue(new InternalServerError('Server error'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(true);
        expect((err as BridgeError).details.providerId).toBe('anthropic');
      }
    });

    it('should map unknown errors to UPSTREAM BridgeError', async () => {
      createFn.mockRejectedValue(new Error('Something unexpected'));

      try {
        await provider.complete([{ role: 'user', content: 'hi' }], { model: 'claude-sonnet-4-20250514' });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).type).toBe('UPSTREAM');
        expect((err as BridgeError).details.retryable).toBe(false);
        expect((err as BridgeError).details.providerId).toBe('anthropic');
        expect((err as BridgeError).cause?.message).toBe('Something unexpected');
      }
    });

    // Feature: multi-provider-agents, Property 8: Provider error classification
    it('property: all SDK error types are classified correctly', async () => {
      const errorFactories = [
        { factory: (msg: string) => new AuthenticationError(msg), expectedType: 'AUTH', retryable: false },
        { factory: (msg: string) => new RateLimitError(msg), expectedType: 'UPSTREAM', retryable: true },
        { factory: (msg: string) => new APIConnectionError(msg), expectedType: 'TRANSPORT', retryable: true },
        { factory: (msg: string) => new APIConnectionTimeoutError(msg), expectedType: 'TIMEOUT', retryable: true },
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
            const localMockAnthropic = class {
              readonly messages = { create: localCreateFn };
              constructor(_opts: { apiKey: string }) { }
            };
            const localProvider = new AnthropicProvider(createConfig(), localMockAnthropic as any);

            try {
              await localProvider.complete([{ role: 'user', content: 'test' }], { model: 'claude-sonnet-4-20250514' });
              expect(true).toBe(false); // Should not reach here
            } catch (err) {
              expect(err).toBeInstanceOf(BridgeError);
              expect((err as BridgeError).type).toBe(expectedType);
              expect((err as BridgeError).details.retryable).toBe(retryable);
              expect((err as BridgeError).details.providerId).toBe('anthropic');
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
          const localMockAnthropic = class {
            readonly messages = { create: localCreateFn };
            constructor(_opts: { apiKey: string }) { }
          };
          const localProvider = new AnthropicProvider(createConfig(), localMockAnthropic as any);

          try {
            await localProvider.complete([{ role: 'user', content: 'test' }], { model: 'claude-sonnet-4-20250514' });
            expect(true).toBe(false); // Should not reach here
          } catch (err) {
            expect(err).toBeInstanceOf(BridgeError);
            expect((err as BridgeError).details.providerId).toBe('anthropic');
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // ── complete() — message handling ───────────────────────────────

  describe('complete() — message handling', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = createProvider();
      createFn.mockResolvedValue(mockSuccessResponse());
    });

    it('should pass non-system messages to the SDK in order', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ];

      await provider.complete(messages, { model: 'claude-sonnet-4-20250514' });
      const callArgs = createFn.mock.calls[0]![0] as Record<string, any>;
      expect(callArgs['messages']).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ]);
    });

    it('property: message order is preserved (excluding system)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(chatMessageArb, { minLength: 1, maxLength: 10 }),
          async (messages) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const localMockAnthropic = class {
              readonly messages = { create: localCreateFn };
              constructor(_opts: { apiKey: string }) { }
            };
            const localProvider = new AnthropicProvider(createConfig(), localMockAnthropic as any);

            await localProvider.complete(messages, { model: 'claude-sonnet-4-20250514' });
            const callArgs = localCreateFn.mock.calls[0]![0] as Record<string, any>;
            const sentMessages = callArgs['messages'] as Array<{ role: string; content: string }>;

            // Non-system messages should be in the same order
            const nonSystemMessages = messages.filter((m) => m.role !== 'system');
            expect(sentMessages.length).toBe(nonSystemMessages.length);
            for (let i = 0; i < nonSystemMessages.length; i++) {
              expect(sentMessages[i]!.role).toBe(nonSystemMessages[i]!.role);
              expect(sentMessages[i]!.content).toBe(nonSystemMessages[i]!.content);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
