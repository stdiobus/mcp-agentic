/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `OpenAIResponsesProvider` — mapping methods and `complete()`.
 *
 * Validates the content-mapping pipeline that feeds into `/v1/responses`:
 * - Property 10: `complete()` always calls `client.responses.create()`,
 *   never `client.chat.completions.create()` (Req 7.2)
 * - Property 11: string and `TextPart` content → `input_text` items (Req 7.6, 7.7)
 * - Property 12: `ImageUrlPart` → `input_image` with optional `detail` (Req 7.3)
 * - FilePart mappings: `file_id`, URL filename (`file_url`), `file_data` (Req 7.4, 7.5)
 * - `mapMessagesToInput`: system-prompt extraction, non-system message forwarding
 * - Validates: Requirements 7.2, 7.3, 7.4, 7.5, 7.6, 7.7
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import { OpenAIResponsesProvider } from '../../../../src/provider/providers/OpenAIResponsesProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import type {
  ChatMessage,
  ContentPart,
  FilePart,
  ImageUrlPart,
  ProviderConfig,
  TextPart,
} from '../../../../src/provider/AIProvider.js';

// ── Local mock SDK error classes ────────────────────────────────
// Defined locally (not imported from 'openai') so the constructor.name
// classification in mapError() is consistent across ESM/CJS environments.

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

// ── Internal SDK response item type (mirrors the private type) ──

interface ResponsesInputItem {
  type: string;
  [key: string]: unknown;
}

interface ResponsesMessage {
  role: string;
  content: string | ResponsesInputItem[];
}

interface ResponsesCreateParams {
  model: string;
  input: ResponsesMessage[];
  system?: string;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
}

// ── Mock SDK factory ────────────────────────────────────────────

function createMockSDK() {
  const responsesCreate = jest.fn<any>();
  const chatCompletionsCreate = jest.fn<any>();
  const filesCreate = jest.fn<any>();
  const filesDelete = jest.fn<any>();

  responsesCreate.mockResolvedValue({
    output_text: 'mock response',
    status: 'completed',
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  class MockOpenAI {
    readonly apiKey: string;
    readonly responses = { create: responsesCreate };
    readonly chat = { completions: { create: chatCompletionsCreate } };
    readonly files = { create: filesCreate, delete: filesDelete };
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
  }

  return { MockOpenAI, responsesCreate, chatCompletionsCreate, filesCreate, filesDelete };
}

// ── Helpers ─────────────────────────────────────────────────────

function createConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    credentials: { apiKey: 'test-key' },
    models: ['gpt-4o'],
    ...overrides,
  };
}

/**
 * Extract the `input` array that was passed to `responses.create` on the
 * most recent call.
 */
function getLastSentInput(responsesCreate: jest.Mock<any>): ResponsesMessage[] {
  const call = responsesCreate.mock.calls[0];
  expect(call).toBeDefined();
  const body = call![0] as ResponsesCreateParams;
  return body.input;
}

function getLastSentParams(responsesCreate: jest.Mock<any>): ResponsesCreateParams {
  const call = responsesCreate.mock.calls[0];
  expect(call).toBeDefined();
  return call![0] as ResponsesCreateParams;
}

// ── fast-check arbitraries ──────────────────────────────────────

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 200 });

const textPartArb: fc.Arbitrary<TextPart> = fc.record({
  type: fc.constant('text' as const),
  text: nonEmptyStringArb,
});

const imageUrlPartArb: fc.Arbitrary<ImageUrlPart> = fc.record(
  {
    type: fc.constant('image_url' as const),
    image_url: fc.record({ url: nonEmptyStringArb }),
    detail: fc.constantFrom('low' as const, 'high' as const, 'original' as const, 'auto' as const),
  },
  { requiredKeys: ['type', 'image_url'] },
);

const filePartArb: fc.Arbitrary<FilePart> = fc
  .record(
    {
      type: fc.constant('file' as const),
      file: fc.record(
        {
          file_id: nonEmptyStringArb,
          filename: nonEmptyStringArb,
          file_data: nonEmptyStringArb,
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: ['type', 'file'] },
  )
  .filter(
    (p) =>
      p.file.file_id !== undefined ||
      p.file.filename !== undefined ||
      p.file.file_data !== undefined,
  );

const contentPartArb: fc.Arbitrary<ContentPart> = fc.oneof(
  textPartArb,
  imageUrlPartArb,
  filePartArb,
);

// ── Tests ───────────────────────────────────────────────────────

describe('OpenAIResponsesProvider — mapContentToResponsesItems and mapMessagesToInput', () => {
  let MockOpenAI: ReturnType<typeof createMockSDK>['MockOpenAI'];
  let responsesCreate: jest.Mock<any>;
  let chatCompletionsCreate: jest.Mock<any>;

  beforeEach(() => {
    const sdk = createMockSDK();
    MockOpenAI = sdk.MockOpenAI;
    responsesCreate = sdk.responsesCreate;
    chatCompletionsCreate = sdk.chatCompletionsCreate;
  });

  function makeProvider(config?: ProviderConfig): OpenAIResponsesProvider {
    return new OpenAIResponsesProvider(config ?? createConfig(), MockOpenAI as any);
  }

  // ── Property 10: always calls /v1/responses ─────────────────────
  // Feature: multimodal-content-and-responses-api, Property 10: always calls /v1/responses
  // Validates: Requirements 7.2
  describe('Property 10: complete() always calls responses.create, never chat.completions.create', () => {
    it('should call client.responses.create exactly once for a simple text message', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'gpt-4o' },
      );

      expect(responsesCreate).toHaveBeenCalledTimes(1);
      expect(chatCompletionsCreate).not.toHaveBeenCalled();
    });

    it('property: responses.create is called exactly once regardless of message content', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              role: fc.constantFrom('user' as const, 'assistant' as const),
              content: nonEmptyStringArb,
            }),
            { minLength: 1, maxLength: 8 },
          ),
          async (rawMessages) => {
            const sdk = createMockSDK();
            const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

            await provider.complete(rawMessages, { model: 'gpt-4o' });

            expect(sdk.responsesCreate).toHaveBeenCalledTimes(1);
            expect(sdk.chatCompletionsCreate).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 50 },
      );
    });

    it('property: responses.create is called once for ContentPart[] messages', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(contentPartArb, { minLength: 1, maxLength: 5 }),
          async (parts) => {
            const sdk = createMockSDK();
            const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

            await provider.complete(
              [{ role: 'user', content: parts }],
              { model: 'gpt-4o' },
            );

            expect(sdk.responsesCreate).toHaveBeenCalledTimes(1);
            expect(sdk.chatCompletionsCreate).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ── Property 11: string and TextPart → input_text ────────────────
  // Feature: multimodal-content-and-responses-api, Property 11: string and TextPart → input_text
  // Validates: Requirements 7.6, 7.7
  describe('Property 11: string content and TextPart both produce input_text items', () => {
    it('should forward a plain string as a string (not wrapped in input_text)', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: 'plain text message' }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      expect(input).toHaveLength(1);
      // Plain strings are passed through as-is by the Responses API
      expect(input[0]!.content).toBe('plain text message');
    });

    it('should map a single TextPart to an input_text item', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'text', text: 'hello from TextPart' }] }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const items = input[0]!.content as ResponsesInputItem[];
      expect(items).toHaveLength(1);
      expect(items[0]!['type']).toBe('input_text');
      expect(items[0]!['text']).toBe('hello from TextPart');
    });

    it('property: any plain string is forwarded as-is (not wrapped)', async () => {
      await fc.assert(
        fc.asyncProperty(nonEmptyStringArb, async (content) => {
          const sdk = createMockSDK();
          const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

          await provider.complete(
            [{ role: 'user', content }],
            { model: 'gpt-4o' },
          );

          const call = sdk.responsesCreate.mock.calls[0];
          const body = call![0] as ResponsesCreateParams;
          const msg = body.input[0]!;

          // String content is passed through as a string value
          expect(typeof msg.content).toBe('string');
          expect(msg.content).toBe(content);
        }),
        { numRuns: 100 },
      );
    });

    it('property: every TextPart produces type=input_text with matching text', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(textPartArb, { minLength: 1, maxLength: 8 }),
          async (parts) => {
            const sdk = createMockSDK();
            const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

            await provider.complete(
              [{ role: 'user', content: parts }],
              { model: 'gpt-4o' },
            );

            const call = sdk.responsesCreate.mock.calls[0];
            const body = call![0] as ResponsesCreateParams;
            const items = body.input[0]!.content as ResponsesInputItem[];

            expect(items).toHaveLength(parts.length);
            for (let i = 0; i < parts.length; i++) {
              expect(items[i]!['type']).toBe('input_text');
              expect(items[i]!['text']).toBe(parts[i]!.text);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── Property 12: ImageUrlPart → input_image ─────────────────────
  // Feature: multimodal-content-and-responses-api, Property 12: ImageUrlPart → input_image
  // Validates: Requirements 7.3
  describe('Property 12: ImageUrlPart → input_image with url and optional detail', () => {
    it('should map ImageUrlPart without detail to input_image', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }] }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['type']).toBe('input_image');
      expect(item['image_url']).toBe('https://example.com/img.png');
      expect(item['detail']).toBeUndefined();
    });

    it('should include detail in input_image when present on the part', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' }, detail: 'high' }],
        }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['type']).toBe('input_image');
      expect(item['detail']).toBe('high');
    });

    it('should use params.detail as fallback when part.detail is undefined', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }] }],
        { model: 'gpt-4o', detail: 'low' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['detail']).toBe('low');
    });

    it('should prefer part.detail over params.detail when both are defined', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' }, detail: 'original' }],
        }],
        { model: 'gpt-4o', detail: 'auto' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['detail']).toBe('original');
    });

    it('property: url is always forwarded exactly; detail present iff defined on part or params', async () => {
      await fc.assert(
        fc.asyncProperty(imageUrlPartArb, async (part) => {
          const sdk = createMockSDK();
          const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

          await provider.complete(
            [{ role: 'user', content: [part] }],
            { model: 'gpt-4o' },
          );

          const call = sdk.responsesCreate.mock.calls[0];
          const body = call![0] as ResponsesCreateParams;
          const item = (body.input[0]!.content as ResponsesInputItem[])[0]!;

          expect(item['type']).toBe('input_image');
          expect(item['image_url']).toBe(part.image_url.url);

          if (part.detail !== undefined) {
            expect(item['detail']).toBe(part.detail);
          } else {
            // No fallback detail in params, so detail must be absent
            expect(item['detail']).toBeUndefined();
          }
        }),
        { numRuns: 100 },
      );
    });

    it('property: all detail values are forwarded correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('low' as const, 'high' as const, 'original' as const, 'auto' as const),
          nonEmptyStringArb,
          async (detail, url) => {
            const sdk = createMockSDK();
            const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);
            const part: ImageUrlPart = { type: 'image_url', image_url: { url }, detail };

            await provider.complete(
              [{ role: 'user', content: [part] }],
              { model: 'gpt-4o' },
            );

            const call = sdk.responsesCreate.mock.calls[0];
            const body = call![0] as ResponsesCreateParams;
            const item = (body.input[0]!.content as ResponsesInputItem[])[0]!;
            expect(item['detail']).toBe(detail);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── FilePart mapping ────────────────────────────────────────────
  // Validates: Requirements 7.4, 7.5
  describe('FilePart mapping — file_id, file_url, and file_data', () => {
    it('should map FilePart with file_id to { type: input_file, file_id }', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file-abc123' } }] }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['type']).toBe('input_file');
      expect(item['file_id']).toBe('file-abc123');
      expect(item['file_url']).toBeUndefined();
      expect(item['file_data']).toBeUndefined();
    });

    it('should map FilePart with HTTP filename to { type: input_file, file_url }', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'file', file: { filename: 'https://example.com/doc.pdf' } }] }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['type']).toBe('input_file');
      expect(item['file_url']).toBe('https://example.com/doc.pdf');
      expect(item['file_id']).toBeUndefined();
      expect(item['file_data']).toBeUndefined();
    });

    it('should map FilePart with file_data to { type: input_file, file_data, filename? }', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'file', file: { file_data: 'base64data==', filename: 'report.pdf' } }] }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['type']).toBe('input_file');
      expect(item['file_data']).toBe('base64data==');
      expect(item['filename']).toBe('report.pdf');
      expect(item['file_id']).toBeUndefined();
      expect(item['file_url']).toBeUndefined();
    });

    it('should map FilePart with file_data and no filename (filename is optional)', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'file', file: { file_data: 'base64data==' } }] }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['type']).toBe('input_file');
      expect(item['file_data']).toBe('base64data==');
      expect(item['filename']).toBeUndefined();
    });

    it('should prefer file_id over URL filename when both are set', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{
          role: 'user',
          content: [{ type: 'file', file: { file_id: 'file-xyz', filename: 'https://example.com/doc.pdf' } }],
        }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['file_id']).toBe('file-xyz');
      expect(item['file_url']).toBeUndefined();
    });

    it('should prefer URL filename over file_data when file_id is absent', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{
          role: 'user',
          content: [{ type: 'file', file: { filename: 'https://example.com/doc.pdf', file_data: 'base64==' } }],
        }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      expect(item['file_url']).toBe('https://example.com/doc.pdf');
      expect(item['file_data']).toBeUndefined();
    });

    it('should NOT treat a non-HTTP filename as a file_url', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'file', file: { filename: 'report.pdf', file_data: 'data==' } }] }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const item = (input[0]!.content as ResponsesInputItem[])[0]!;
      // Non-HTTP filename → falls through to file_data path
      expect(item['type']).toBe('input_file');
      expect(item['file_data']).toBe('data==');
      expect(item['file_url']).toBeUndefined();
    });
  });

  // ── mapMessagesToInput: system prompt extraction ─────────────────
  // Validates: Requirements 7.7 (system prompt handling)
  describe('mapMessagesToInput — system prompt extraction', () => {
    it('should extract string system message as top-level system field', async () => {
      const provider = makeProvider();

      await provider.complete(
        [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'gpt-4o' },
      );

      const params = getLastSentParams(responsesCreate);
      expect(params.instructions).toBe('You are a helpful assistant.');
      // System message must not appear in input[]
      const systemInInput = params.input.some((m) => m.role === 'system');
      expect(systemInInput).toBe(false);
    });

    it('should prefer params.systemPrompt over system messages in the array', async () => {
      const provider = makeProvider();

      await provider.complete(
        [
          { role: 'system', content: 'Ignored system message' },
          { role: 'user', content: 'Hello' },
        ],
        { model: 'gpt-4o', systemPrompt: 'Override system prompt' },
      );

      const params = getLastSentParams(responsesCreate);
      expect(params.instructions).toBe('Override system prompt');
    });

    it('should extract TextPart values from ContentPart[] system messages', async () => {
      const provider = makeProvider();

      const systemMsg: ChatMessage = {
        role: 'system',
        content: [
          { type: 'text', text: 'You are a helpful assistant.' },
          { type: 'image_url', image_url: { url: 'https://example.com/logo.png' } }, // should be ignored
          { type: 'text', text: ' Be concise.' },
        ],
      };

      await provider.complete(
        [systemMsg, { role: 'user', content: 'Hi' }],
        { model: 'gpt-4o' },
      );

      const params = getLastSentParams(responsesCreate);
      expect(params.instructions).toBe('You are a helpful assistant.\n Be concise.');
    });

    it('should concatenate multiple system messages with newlines', async () => {
      const provider = makeProvider();

      await provider.complete(
        [
          { role: 'system', content: 'Line one.' },
          { role: 'user', content: 'Hello' },
          { role: 'system', content: 'Line two.' },
        ],
        { model: 'gpt-4o' },
      );

      const params = getLastSentParams(responsesCreate);
      expect(params.instructions).toBe('Line one.\nLine two.');
    });

    it('should omit the system field entirely when no system prompt is present', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: 'Hello' }],
        { model: 'gpt-4o' },
      );

      const params = getLastSentParams(responsesCreate);
      expect(params.instructions).toBeUndefined();
    });

    it('should include only non-system messages in the input array', async () => {
      const provider = makeProvider();

      await provider.complete(
        [
          { role: 'system', content: 'System prompt.' },
          { role: 'user', content: 'First user message' },
          { role: 'assistant', content: 'First assistant response' },
          { role: 'user', content: 'Second user message' },
        ],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      expect(input).toHaveLength(3);
      expect(input[0]!.role).toBe('user');
      expect(input[0]!.content).toBe('First user message');
      expect(input[1]!.role).toBe('assistant');
      expect(input[2]!.role).toBe('user');
    });

    it('property: system messages are never present in the input array', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(nonEmptyStringArb, { minLength: 0, maxLength: 3 }),
          fc.array(
            fc.record({
              role: fc.constantFrom('user' as const, 'assistant' as const),
              content: nonEmptyStringArb,
            }),
            { minLength: 1, maxLength: 5 },
          ),
          async (systemTexts, nonSystemMessages) => {
            const sdk = createMockSDK();
            const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

            const messages: ChatMessage[] = [
              ...systemTexts.map((text): ChatMessage => ({ role: 'system', content: text })),
              ...nonSystemMessages,
            ];

            await provider.complete(messages, { model: 'gpt-4o' });

            const call = sdk.responsesCreate.mock.calls[0];
            const body = call![0] as ResponsesCreateParams;
            const hasSystemInInput = body.input.some((m) => m.role === 'system');
            expect(hasSystemInInput).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── complete() — runtime params forwarding ──────────────────────
  describe('complete() — runtime parameter forwarding', () => {
    it('should forward temperature, maxTokens, and topP to the SDK call', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: 'Hi' }],
        { model: 'gpt-4o', temperature: 0.7, maxTokens: 256, topP: 0.9 },
      );

      const params = getLastSentParams(responsesCreate);
      expect(params.temperature).toBe(0.7);
      expect(params.max_output_tokens).toBe(256);
      expect(params.top_p).toBe(0.9);
    });

    it('should omit optional params when not specified', async () => {
      const provider = makeProvider();

      await provider.complete(
        [{ role: 'user', content: 'Hi' }],
        { model: 'gpt-4o' },
      );

      const params = getLastSentParams(responsesCreate);
      expect(params.temperature).toBeUndefined();
      expect(params.max_output_tokens).toBeUndefined();
      expect(params.top_p).toBeUndefined();
    });

    it('should normalize the response into AIProviderResult', async () => {
      const provider = makeProvider();

      const result = await provider.complete(
        [{ role: 'user', content: 'Hi' }],
        { model: 'gpt-4o' },
      );

      expect(result.text).toBe('mock response');
      expect(result.stopReason).toBe('end_turn');  // 'completed' → 'end_turn'
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });
  });

  // ── Capabilities ────────────────────────────────────────────────
  // Validates: Requirements 7.9, 7.12, 10.4, 10.5
  describe('capabilities', () => {
    it('should expose capabilities.vision = true', () => {
      const { MockOpenAI: SDK } = createMockSDK();
      const provider = new OpenAIResponsesProvider(createConfig(), SDK as any);
      expect(provider.capabilities.vision).toBe(true);
    });

    it('should expose capabilities.jsonMode = true', () => {
      const { MockOpenAI: SDK } = createMockSDK();
      const provider = new OpenAIResponsesProvider(createConfig(), SDK as any);
      expect(provider.capabilities.jsonMode).toBe(true);
    });

    it('should expose capabilities.files = true', () => {
      const { MockOpenAI: SDK } = createMockSDK();
      const provider = new OpenAIResponsesProvider(createConfig(), SDK as any);
      expect(provider.capabilities.files).toBe(true);
    });

    it('should expose capabilities.streaming = false', () => {
      const { MockOpenAI: SDK } = createMockSDK();
      const provider = new OpenAIResponsesProvider(createConfig(), SDK as any);
      expect(provider.capabilities.streaming).toBe(false);
    });
  });

  // ── FilesAPI — create and delete ────────────────────────────────
  // Validates: Requirements 2.8, 2.9, 7.8
  describe('FilesAPI — create() and delete()', () => {
    it('provider.files should be defined', () => {
      const { MockOpenAI: SDK } = createMockSDK();
      const provider = new OpenAIResponsesProvider(createConfig(), SDK as any);
      expect(provider.files).toBeDefined();
    });

    describe('files.create()', () => {
      it('should upload a string content file and return UploadedFile', async () => {
        const sdk = createMockSDK();
        sdk.filesCreate.mockResolvedValue({ id: 'file-created-001', filename: 'report.pdf' });
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

        const result = await provider.files!.create({
          filename: 'report.pdf',
          content: 'PDF text content',
          mimeType: 'application/pdf',
        });

        expect(result).toEqual({ fileId: 'file-created-001', filename: 'report.pdf' });
        expect(sdk.filesCreate).toHaveBeenCalledTimes(1);
        const [params] = sdk.filesCreate.mock.calls[0]! as [{ file: File; purpose: string }, unknown];
        expect(params.purpose).toBe('assistants');
        expect(params.file).toBeInstanceOf(File);
        expect(params.file.name).toBe('report.pdf');
        expect(params.file.type).toBe('application/pdf');
      });

      it('should upload a Uint8Array content file and return UploadedFile', async () => {
        const sdk = createMockSDK();
        sdk.filesCreate.mockResolvedValue({ id: 'file-bytes-002', filename: 'data.bin' });
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

        const bytes = new Uint8Array([0x00, 0x01, 0x02]);
        const result = await provider.files!.create({
          filename: 'data.bin',
          content: bytes,
          mimeType: 'application/octet-stream',
        });

        expect(result).toEqual({ fileId: 'file-bytes-002', filename: 'data.bin' });
        const [params] = sdk.filesCreate.mock.calls[0]! as [{ file: File; purpose: string }, unknown];
        expect(params.file.type).toBe('application/octet-stream');
      });

      it('should pass signal to sdk.files.create when provided', async () => {
        const sdk = createMockSDK();
        sdk.filesCreate.mockResolvedValue({ id: 'file-signal-003', filename: 'sig.txt' });
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);
        const controller = new AbortController();

        await provider.files!.create(
          { filename: 'sig.txt', content: 'hello', mimeType: 'text/plain' },
          controller.signal,
        );

        const [, options] = sdk.filesCreate.mock.calls[0]! as [unknown, { signal?: AbortSignal }];
        expect(options?.signal).toBe(controller.signal);
      });

      it('should rethrow SDK error as BridgeError.upstream (UPSTREAM category)', async () => {
        const sdk = createMockSDK();
        sdk.filesCreate.mockRejectedValue(new Error('Network failure during upload'));
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

        await expect(
          provider.files!.create({ filename: 'x.pdf', content: 'data', mimeType: 'application/pdf' }),
        ).rejects.toMatchObject({
          name: 'BridgeError',
          type: 'UPSTREAM',
          message: 'Network failure during upload',
        });
      });

      it('should pass through an existing BridgeError unchanged', async () => {
        const sdk = createMockSDK();
        const original = BridgeError.auth('Auth error from files create');
        sdk.filesCreate.mockRejectedValue(original);
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

        await expect(
          provider.files!.create({ filename: 'x.pdf', content: 'data', mimeType: 'application/pdf' }),
        ).rejects.toBe(original);
      });
    });

    describe('files.delete()', () => {
      it('should delete a file by id without error', async () => {
        const sdk = createMockSDK();
        sdk.filesDelete.mockResolvedValue(undefined);
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

        await expect(provider.files!.delete('file-to-delete-123')).resolves.toBeUndefined();
        expect(sdk.filesDelete).toHaveBeenCalledWith('file-to-delete-123', expect.objectContaining({}));
      });

      it('should pass signal to sdk.files.delete when provided', async () => {
        const sdk = createMockSDK();
        sdk.filesDelete.mockResolvedValue(undefined);
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);
        const controller = new AbortController();

        await provider.files!.delete('file-sig-456', controller.signal);

        const [, options] = sdk.filesDelete.mock.calls[0]! as [string, { signal?: AbortSignal }];
        expect(options?.signal).toBe(controller.signal);
      });

      it('should rethrow SDK error as BridgeError.upstream (UPSTREAM category)', async () => {
        const sdk = createMockSDK();
        sdk.filesDelete.mockRejectedValue(new Error('Delete failed: file not found'));
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

        await expect(provider.files!.delete('missing-file-id')).rejects.toMatchObject({
          name: 'BridgeError',
          type: 'UPSTREAM',
          message: 'Delete failed: file not found',
        });
      });

      it('should pass through an existing BridgeError unchanged on delete', async () => {
        const sdk = createMockSDK();
        const original = BridgeError.transport('Transport error from files delete');
        sdk.filesDelete.mockRejectedValue(original);
        const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

        await expect(provider.files!.delete('file-xyz')).rejects.toBe(original);
      });
    });
  });

  // ── Mixed ContentPart arrays ────────────────────────────────────
  describe('mixed ContentPart[] in a single message', () => {
    it('should map all three part types in the correct order', async () => {
      const provider = makeProvider();
      const parts: ContentPart[] = [
        { type: 'text', text: 'Look at this:' },
        { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' }, detail: 'low' },
        { type: 'file', file: { file_id: 'file-123' } },
      ];

      await provider.complete(
        [{ role: 'user', content: parts }],
        { model: 'gpt-4o' },
      );

      const input = getLastSentInput(responsesCreate);
      const items = input[0]!.content as ResponsesInputItem[];
      expect(items).toHaveLength(3);
      expect(items[0]!['type']).toBe('input_text');
      expect(items[1]!['type']).toBe('input_image');
      expect(items[2]!['type']).toBe('input_file');
    });

    it('property: ContentPart[] length is preserved (no parts dropped)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(contentPartArb, { minLength: 1, maxLength: 8 }),
          async (parts) => {
            const sdk = createMockSDK();
            const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);

            await provider.complete(
              [{ role: 'user', content: parts }],
              { model: 'gpt-4o' },
            );

            const call = sdk.responsesCreate.mock.calls[0];
            const body = call![0] as ResponsesCreateParams;
            const items = body.input[0]!.content as ResponsesInputItem[];
            expect(items).toHaveLength(parts.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

// ── Error classification tests ─────────────────────────────────
// Validates: Requirements 7.2, 7.9

describe('OpenAIResponsesProvider — mapError() error classification', () => {
  function makeProvider(): OpenAIResponsesProvider {
    const sdk = createMockSDK();
    return new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);
  }

  function makeProviderWithRejection(sdkError: unknown): {
    provider: OpenAIResponsesProvider;
  } {
    const sdk = createMockSDK();
    sdk.responsesCreate.mockRejectedValue(sdkError);
    const provider = new OpenAIResponsesProvider(createConfig(), sdk.MockOpenAI as any);
    return { provider };
  }

  it('should pass through a BridgeError unchanged', async () => {
    const original = BridgeError.internal('test');
    const { provider } = makeProviderWithRejection(original);

    await expect(
      provider.complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' }),
    ).rejects.toBe(original);
  });

  it('should map AuthenticationError to BridgeError AUTH (not retryable)', async () => {
    const { provider } = makeProviderWithRejection(new AuthenticationError());

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('AUTH');
    expect((err as BridgeError).details.retryable).toBe(false);
  });

  it('should map RateLimitError to BridgeError UPSTREAM (retryable)', async () => {
    const { provider } = makeProviderWithRejection(new RateLimitError());

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('UPSTREAM');
    expect((err as BridgeError).details.retryable).toBe(true);
  });

  it('should map APIConnectionError to BridgeError TRANSPORT (retryable)', async () => {
    const { provider } = makeProviderWithRejection(new APIConnectionError());

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('TRANSPORT');
    expect((err as BridgeError).details.retryable).toBe(true);
  });

  it('should map APITimeoutError to BridgeError TIMEOUT (retryable)', async () => {
    const { provider } = makeProviderWithRejection(new APITimeoutError());

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('TIMEOUT');
    expect((err as BridgeError).details.retryable).toBe(true);
  });

  it('should map BadRequestError to BridgeError UPSTREAM (not retryable)', async () => {
    const { provider } = makeProviderWithRejection(new BadRequestError());

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('UPSTREAM');
    expect((err as BridgeError).details.retryable).toBe(false);
  });

  it('should map InternalServerError to BridgeError UPSTREAM (retryable)', async () => {
    const { provider } = makeProviderWithRejection(new InternalServerError());

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('UPSTREAM');
    expect((err as BridgeError).details.retryable).toBe(true);
  });

  it('should map unknown errors to BridgeError UPSTREAM (not retryable)', async () => {
    const { provider } = makeProviderWithRejection(new Error('something went wrong'));

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('UPSTREAM');
    expect((err as BridgeError).details.retryable).toBe(false);
  });

  it('should include the provider id in error details', async () => {
    const { provider } = makeProviderWithRejection(new AuthenticationError());

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect((err as BridgeError).details['providerId']).toBe('openai-responses');
  });

  it('should preserve the original error message', async () => {
    const { provider } = makeProviderWithRejection(new BadRequestError('Invalid content type'));

    const err = await provider
      .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect((err as BridgeError).message).toBe('Invalid content type');
  });

  it('property: all retryable errors produce retryable BridgeError', async () => {
    const retryableErrors = [
      new RateLimitError(),
      new APIConnectionError(),
      new APITimeoutError(),
      new InternalServerError(),
    ];

    for (const sdkErr of retryableErrors) {
      const { provider } = makeProviderWithRejection(sdkErr);
      const err = await provider
        .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
        .catch((e: unknown) => e);

      expect((err as BridgeError).details.retryable).toBe(true);
    }
  });

  it('property: all non-retryable errors produce non-retryable BridgeError', async () => {
    const nonRetryableErrors = [
      new AuthenticationError(),
      new BadRequestError(),
      new Error('generic error'),
    ];

    for (const sdkErr of nonRetryableErrors) {
      const { provider } = makeProviderWithRejection(sdkErr);
      const err = await provider
        .complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' })
        .catch((e: unknown) => e);

      expect((err as BridgeError).details.retryable).toBe(false);
    }
  });
});
