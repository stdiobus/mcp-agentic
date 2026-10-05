/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for OpenAIProvider multimodal content mapping.
 *
 * Validates that `OpenAIProvider.complete()` correctly converts every
 * `ChatMessage.content` shape into the expected OpenAI Chat Completions
 * SDK request body.
 *
 * Tests cover:
 * - Property 2: string content pass-through (Req 4.1)
 * - Property 3: TextPart → { type: 'text', text } (Req 4.2)
 * - Property 4: ImageUrlPart → { type: 'image_url', image_url: { url, detail? } } (Req 4.3)
 * - Property 5: FilePart → { type: 'file', file: { ... } } (Req 4.4)
 * - Validates: Requirements 4.1, 4.2, 4.3, 4.4, 10.1
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import { OpenAIProvider } from '../../../../src/provider/providers/OpenAIProvider.js';
import type {
  ChatMessage,
  ContentPart,
  FilePart,
  ImageUrlPart,
  ProviderConfig,
  TextPart,
} from '../../../../src/provider/AIProvider.js';

// ── Mock SDK factory ────────────────────────────────────────────

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
    models: ['gpt-4o', 'gpt-4'],
    ...overrides,
  };
}

function mockSuccessResponse() {
  return {
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

/**
 * Extract the messages array that the mock SDK received on its most
 * recent `chat.completions.create` call.
 */
function getLastSentMessages(createFn: jest.Mock<any>): Array<{ role: string; content: unknown }> {
  const call = createFn.mock.calls[0];
  expect(call).toBeDefined();
  const body = call![0] as Record<string, unknown>;
  return body['messages'] as Array<{ role: string; content: unknown }>;
}

// ── fast-check arbitraries ──────────────────────────────────────

/** Non-empty printable string, representable as a JSON value. */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 200 });

/** Arbitrary TextPart. */
const textPartArb: fc.Arbitrary<TextPart> = fc.record({
  type: fc.constant('text' as const),
  text: nonEmptyStringArb,
});

/** Arbitrary ImageUrlPart — detail field optionally present. */
const imageUrlPartArb: fc.Arbitrary<ImageUrlPart> = fc.record(
  {
    type: fc.constant('image_url' as const),
    image_url: fc.record({ url: nonEmptyStringArb }),
    detail: fc.constantFrom('low' as const, 'high' as const, 'original' as const, 'auto' as const),
  },
  { requiredKeys: ['type', 'image_url'] },
);

/** Arbitrary FilePart with at least one of file_id / filename / file_data defined. */
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
  .filter((p) => {
    // Ensure at least one sub-field is present at runtime (per Req 1.5)
    return (
      p.file.file_id !== undefined ||
      p.file.filename !== undefined ||
      p.file.file_data !== undefined
    );
  });

/** Arbitrary ContentPart (any of the three types). */
const contentPartArb: fc.Arbitrary<ContentPart> = fc.oneof(
  textPartArb,
  imageUrlPartArb,
  filePartArb,
);

// ── Tests ───────────────────────────────────────────────────────

describe('OpenAIProvider — multimodal content mapping', () => {
  let MockOpenAI: any;
  let createFn: jest.Mock<any>;

  beforeEach(() => {
    const sdk = createMockOpenAISDK();
    MockOpenAI = sdk.MockOpenAI;
    createFn = sdk.createFn;
    createFn.mockResolvedValue(mockSuccessResponse());
  });

  function createProvider(config?: ProviderConfig): OpenAIProvider {
    return new OpenAIProvider(config ?? createConfig(), MockOpenAI);
  }

  // ── Property 2: string content pass-through ─────────────────────
  // Feature: multimodal-content-and-responses-api, Property 2: string content pass-through
  // Validates: Requirements 4.1, 10.1
  describe('Property 2: string content pass-through', () => {
    it('should forward string content unchanged for a single user message', async () => {
      const provider = createProvider();

      await provider.complete(
        [{ role: 'user', content: 'Hello, world!' }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      expect(messages[0]).toEqual({ role: 'user', content: 'Hello, world!' });
    });

    it('property: any string content is forwarded exactly as-is', async () => {
      await fc.assert(
        fc.asyncProperty(nonEmptyStringArb, async (content) => {
          const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
          const LocalMockOpenAI = class {
            readonly chat = { completions: { create: localCreateFn } };
            constructor(_opts: { apiKey: string }) { }
          };
          const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

          const message: ChatMessage = { role: 'user', content };
          await provider.complete([message], { model: 'gpt-4o' });

          const call = localCreateFn.mock.calls[0];
          const body = call![0] as Record<string, unknown>;
          const messages = body['messages'] as Array<{ role: string; content: unknown }>;

          // The single message must arrive with its content unchanged
          expect(messages[0]!.content).toBe(content);
          expect(typeof messages[0]!.content).toBe('string');
        }),
        { numRuns: 100 },
      );
    });

    it('property: multiple string-content messages preserve order and content', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              role: fc.constantFrom('user' as const, 'assistant' as const),
              content: nonEmptyStringArb,
            }),
            { minLength: 1, maxLength: 10 },
          ),
          async (rawMessages) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const LocalMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

            await provider.complete(rawMessages, { model: 'gpt-4o' });

            const call = localCreateFn.mock.calls[0];
            const body = call![0] as Record<string, unknown>;
            const sentMessages = body['messages'] as Array<{ role: string; content: unknown }>;

            // Each message must match in position, role, and content
            for (let i = 0; i < rawMessages.length; i++) {
              expect(sentMessages[i]!.role).toBe(rawMessages[i]!.role);
              expect(sentMessages[i]!.content).toBe(rawMessages[i]!.content);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── Property 3: TextPart → { type: 'text', text } ───────────────
  // Feature: multimodal-content-and-responses-api, Property 3: TextPart → { type: 'text', text }
  // Validates: Requirements 4.2, 10.1
  describe('Property 3: TextPart → { type: "text", text }', () => {
    it('should convert a single TextPart to the correct SDK block', async () => {
      const provider = createProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'text', text: 'Hello from a TextPart' }] }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      const blocks = messages[0]!.content as Array<Record<string, unknown>>;
      expect(blocks[0]).toEqual({ type: 'text', text: 'Hello from a TextPart' });
    });

    it('property: every TextPart produces type="text" and text matching the input', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(textPartArb, { minLength: 1, maxLength: 10 }),
          async (parts) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const LocalMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

            await provider.complete(
              [{ role: 'user', content: parts }],
              { model: 'gpt-4o' },
            );

            const call = localCreateFn.mock.calls[0];
            const body = call![0] as Record<string, unknown>;
            const messages = body['messages'] as Array<{ role: string; content: unknown }>;
            const blocks = messages[0]!.content as Array<Record<string, unknown>>;

            expect(blocks).toHaveLength(parts.length);
            for (let i = 0; i < parts.length; i++) {
              expect(blocks[i]!['type']).toBe('text');
              expect(blocks[i]!['text']).toBe(parts[i]!.text);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: TextPart blocks carry no extra fields beyond type and text', async () => {
      await fc.assert(
        fc.asyncProperty(textPartArb, async (part) => {
          const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
          const LocalMockOpenAI = class {
            readonly chat = { completions: { create: localCreateFn } };
            constructor(_opts: { apiKey: string }) { }
          };
          const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

          await provider.complete(
            [{ role: 'user', content: [part] }],
            { model: 'gpt-4o' },
          );

          const call = localCreateFn.mock.calls[0];
          const body = call![0] as Record<string, unknown>;
          const messages = body['messages'] as Array<{ role: string; content: unknown }>;
          const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;

          // Only 'type' and 'text' keys should be present
          const keys = Object.keys(block);
          expect(keys.sort()).toEqual(['text', 'type'].sort());
        }),
        { numRuns: 100 },
      );
    });
  });

  // ── Property 4: ImageUrlPart → { type: 'image_url', image_url: { url, detail? } } ──
  // Feature: multimodal-content-and-responses-api, Property 4: ImageUrlPart → { type: 'image_url', image_url: { url, detail? } }
  // Validates: Requirements 4.3, 10.1
  describe('Property 4: ImageUrlPart → { type: "image_url", image_url: { url, detail? } }', () => {
    it('should convert ImageUrlPart without detail correctly', async () => {
      const provider = createProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }] }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
      expect(block['type']).toBe('image_url');
      expect((block['image_url'] as Record<string, unknown>)['url']).toBe('https://example.com/img.png');
      expect((block['image_url'] as Record<string, unknown>)['detail']).toBeUndefined();
    });

    it('should include detail in the SDK block when present on the part', async () => {
      const provider = createProvider();

      await provider.complete(
        [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' }, detail: 'high' }],
        }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
      expect((block['image_url'] as Record<string, unknown>)['detail']).toBe('high');
    });

    it('property: url is always forwarded exactly; detail present iff defined on part', async () => {
      await fc.assert(
        fc.asyncProperty(imageUrlPartArb, async (part) => {
          const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
          const LocalMockOpenAI = class {
            readonly chat = { completions: { create: localCreateFn } };
            constructor(_opts: { apiKey: string }) { }
          };
          const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

          await provider.complete(
            [{ role: 'user', content: [part] }],
            { model: 'gpt-4o' },
          );

          const call = localCreateFn.mock.calls[0];
          const body = call![0] as Record<string, unknown>;
          const messages = body['messages'] as Array<{ role: string; content: unknown }>;
          const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
          const imageUrl = block['image_url'] as Record<string, unknown>;

          // type must be 'image_url'
          expect(block['type']).toBe('image_url');

          // url must match exactly
          expect(imageUrl['url']).toBe(part.image_url.url);

          // detail: present iff defined on the source part
          if (part.detail !== undefined) {
            expect(imageUrl['detail']).toBe(part.detail);
          } else {
            expect(imageUrl['detail']).toBeUndefined();
          }
        }),
        { numRuns: 100 },
      );
    });

    it('property: all valid detail values are forwarded correctly', async () => {
      const detailValues = ['low', 'high', 'original', 'auto'] as const;

      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...detailValues),
          nonEmptyStringArb,
          async (detail, url) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const LocalMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

            const part: ImageUrlPart = { type: 'image_url', image_url: { url }, detail };
            await provider.complete(
              [{ role: 'user', content: [part] }],
              { model: 'gpt-4o' },
            );

            const call = localCreateFn.mock.calls[0];
            const body = call![0] as Record<string, unknown>;
            const messages = body['messages'] as Array<{ role: string; content: unknown }>;
            const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
            const imageUrl = block['image_url'] as Record<string, unknown>;

            expect(imageUrl['detail']).toBe(detail);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── Property 5: FilePart → { type: 'file', file: { ... } } ─────
  // Feature: multimodal-content-and-responses-api, Property 5: FilePart → { type: 'file', file: { ... } }
  // Validates: Requirements 4.4, 10.1
  describe('Property 5: FilePart → { type: "file", file: { ... } }', () => {
    it('should convert FilePart with file_id to the correct SDK block', async () => {
      const provider = createProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'file', file: { file_id: 'file-abc123' } }] }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
      expect(block['type']).toBe('file');
      expect((block['file'] as Record<string, unknown>)['file_id']).toBe('file-abc123');
    });

    it('should convert FilePart with filename to the correct SDK block', async () => {
      const provider = createProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'file', file: { filename: 'doc.pdf' } }] }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
      expect(block['type']).toBe('file');
      expect((block['file'] as Record<string, unknown>)['filename']).toBe('doc.pdf');
    });

    it('should convert FilePart with file_data to the correct SDK block', async () => {
      const provider = createProvider();

      await provider.complete(
        [{ role: 'user', content: [{ type: 'file', file: { file_data: 'base64content==' } }] }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
      expect(block['type']).toBe('file');
      expect((block['file'] as Record<string, unknown>)['file_data']).toBe('base64content==');
    });

    it('property: all defined sub-fields of FilePart.file are preserved exactly', async () => {
      await fc.assert(
        fc.asyncProperty(filePartArb, async (part) => {
          const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
          const LocalMockOpenAI = class {
            readonly chat = { completions: { create: localCreateFn } };
            constructor(_opts: { apiKey: string }) { }
          };
          const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

          await provider.complete(
            [{ role: 'user', content: [part] }],
            { model: 'gpt-4o' },
          );

          const call = localCreateFn.mock.calls[0];
          const body = call![0] as Record<string, unknown>;
          const messages = body['messages'] as Array<{ role: string; content: unknown }>;
          const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
          const fileBlock = block['file'] as Record<string, unknown>;

          // type must be 'file'
          expect(block['type']).toBe('file');

          // each defined sub-field must be preserved with identical value
          if (part.file.file_id !== undefined) {
            expect(fileBlock['file_id']).toBe(part.file.file_id);
          }
          if (part.file.filename !== undefined) {
            expect(fileBlock['filename']).toBe(part.file.filename);
          }
          if (part.file.file_data !== undefined) {
            expect(fileBlock['file_data']).toBe(part.file.file_data);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('property: undefined sub-fields of FilePart.file are not present in the SDK block', async () => {
      await fc.assert(
        fc.asyncProperty(filePartArb, async (part) => {
          const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
          const LocalMockOpenAI = class {
            readonly chat = { completions: { create: localCreateFn } };
            constructor(_opts: { apiKey: string }) { }
          };
          const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

          await provider.complete(
            [{ role: 'user', content: [part] }],
            { model: 'gpt-4o' },
          );

          const call = localCreateFn.mock.calls[0];
          const body = call![0] as Record<string, unknown>;
          const messages = body['messages'] as Array<{ role: string; content: unknown }>;
          const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
          const fileBlock = block['file'] as Record<string, unknown>;

          // Sub-fields that were undefined must not appear as defined keys
          if (part.file.file_id === undefined) {
            expect(fileBlock['file_id']).toBeUndefined();
          }
          if (part.file.filename === undefined) {
            expect(fileBlock['filename']).toBeUndefined();
          }
          if (part.file.file_data === undefined) {
            expect(fileBlock['file_data']).toBeUndefined();
          }
        }),
        { numRuns: 100 },
      );
    });

    it('should handle FilePart with all three sub-fields defined simultaneously', async () => {
      const provider = createProvider();
      const part: FilePart = {
        type: 'file',
        file: { file_id: 'file-xyz', filename: 'report.pdf', file_data: 'abc123==' },
      };

      await provider.complete(
        [{ role: 'user', content: [part] }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      const block = (messages[0]!.content as Array<Record<string, unknown>>)[0]!;
      const fileBlock = block['file'] as Record<string, unknown>;

      expect(block['type']).toBe('file');
      expect(fileBlock['file_id']).toBe('file-xyz');
      expect(fileBlock['filename']).toBe('report.pdf');
      expect(fileBlock['file_data']).toBe('abc123==');
    });
  });

  // ── Mixed ContentPart[] arrays ──────────────────────────────────

  describe('mixed ContentPart[] arrays', () => {
    it('should handle a mix of all three part types in a single message', async () => {
      const provider = createProvider();
      const parts: ContentPart[] = [
        { type: 'text', text: 'Look at this image:' },
        { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' }, detail: 'low' },
        { type: 'file', file: { file_id: 'file-123' } },
      ];

      await provider.complete(
        [{ role: 'user', content: parts }],
        { model: 'gpt-4o' },
      );

      const messages = getLastSentMessages(createFn);
      const blocks = messages[0]!.content as Array<Record<string, unknown>>;

      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toEqual({ type: 'text', text: 'Look at this image:' });
      expect(blocks[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/photo.jpg', detail: 'low' },
      });
      expect(blocks[2]).toEqual({ type: 'file', file: { file_id: 'file-123' } });
    });

    it('property: part count and order are preserved in a mixed ContentPart[] message', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(contentPartArb, { minLength: 1, maxLength: 8 }),
          async (parts) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const LocalMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

            await provider.complete(
              [{ role: 'user', content: parts }],
              { model: 'gpt-4o' },
            );

            const call = localCreateFn.mock.calls[0];
            const body = call![0] as Record<string, unknown>;
            const messages = body['messages'] as Array<{ role: string; content: unknown }>;
            const blocks = messages[0]!.content as Array<Record<string, unknown>>;

            // Block count must match part count (no omissions for OpenAIProvider)
            expect(blocks).toHaveLength(parts.length);

            // Each block type must correspond to its source part type
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i]!;
              const block = blocks[i]!;
              expect(block['type']).toBe(part.type);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: content is either a string or an array, never converted between the two forms', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            nonEmptyStringArb.map((s) => ({ content: s as string | ContentPart[], isString: true })),
            fc.array(contentPartArb, { minLength: 1, maxLength: 5 }).map((p) => ({
              content: p as string | ContentPart[],
              isString: false,
            })),
          ),
          async ({ content, isString }) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const LocalMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

            await provider.complete(
              [{ role: 'user', content }],
              { model: 'gpt-4o' },
            );

            const call = localCreateFn.mock.calls[0];
            const body = call![0] as Record<string, unknown>;
            const messages = body['messages'] as Array<{ role: string; content: unknown }>;
            const sentContent = messages[0]!.content;

            if (isString) {
              expect(typeof sentContent).toBe('string');
            } else {
              expect(Array.isArray(sentContent)).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── Role preservation ────────────────────────────────────────────

  describe('role preservation with ContentPart[] content', () => {
    it('property: message role is preserved when content is ContentPart[]', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('user' as const, 'assistant' as const),
          fc.array(textPartArb, { minLength: 1, maxLength: 3 }),
          async (role, parts) => {
            const localCreateFn = jest.fn<any>().mockResolvedValue(mockSuccessResponse());
            const LocalMockOpenAI = class {
              readonly chat = { completions: { create: localCreateFn } };
              constructor(_opts: { apiKey: string }) { }
            };
            const provider = new OpenAIProvider(createConfig(), LocalMockOpenAI as any);

            await provider.complete(
              [{ role, content: parts }],
              { model: 'gpt-4o' },
            );

            const call = localCreateFn.mock.calls[0];
            const body = call![0] as Record<string, unknown>;
            const messages = body['messages'] as Array<{ role: string; content: unknown }>;

            expect(messages[0]!.role).toBe(role);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
