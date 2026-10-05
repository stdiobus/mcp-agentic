/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for GoogleGeminiProvider multimodal content mapping.
 *
 * Tests cover the `mapChatMessageToGemini` private method exercised through
 * the public `complete()` API, verifying that ChatMessage content is correctly
 * converted to Gemini `Content[]` format for all content shapes.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 10.3**
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import * as fc from 'fast-check';
import { GoogleGeminiProvider } from '../../../../src/provider/providers/GoogleGeminiProvider.js';
import type { ChatMessage, ContentPart, ProviderConfig } from '../../../../src/provider/AIProvider.js';

// ── Mock SDK factory ────────────────────────────────────────────

/**
 * Build an isolated mock SDK class + captured generateContent spy.
 * Each test that needs per-call control creates its own instance so
 * concurrent fast-check runs do not share state.
 */
function createMockSDK() {
  const generateContentFn = jest.fn<any>();

  class MockGoogleGenerativeAI {
    constructor(readonly apiKey: string) { }

    getGenerativeModel(_params: { model: string }) {
      return { generateContent: generateContentFn };
    }
  }

  return { MockGoogleGenerativeAI, generateContentFn };
}

// ── Helpers ─────────────────────────────────────────────────────

function baseConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    credentials: { apiKey: 'test-key' },
    models: ['gemini-1.5-pro'],
    ...overrides,
  };
}

/** A minimal Gemini success response so complete() doesn't throw. */
function geminiSuccess(text = 'ok') {
  return {
    response: {
      candidates: [
        { content: { parts: [{ text }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
  };
}

/**
 * Run complete() on a fresh provider+SDK pair and return the `contents`
 * array passed to the SDK's generateContent mock.
 */
async function captureContents(
  messages: ChatMessage[],
): Promise<Array<{ role: string; parts: unknown[] }>> {
  const { MockGoogleGenerativeAI, generateContentFn } = createMockSDK();
  generateContentFn.mockResolvedValue(geminiSuccess());
  const provider = new GoogleGeminiProvider(baseConfig(), MockGoogleGenerativeAI as any);
  await provider.complete(messages, { model: 'gemini-1.5-pro' });
  const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
  return callArg['contents'] as Array<{ role: string; parts: unknown[] }>;
}

// ── fast-check arbitraries ──────────────────────────────────────

/** Non-empty printable string (avoids empty-string edge cases already covered separately). */
const nonEmptyString = fc.string({ minLength: 1, maxLength: 200 });

/** Valid HTTP/HTTPS URL string. */
const urlString = fc.webUrl({ validSchemes: ['http', 'https'] });

/** TextPart arbitrary. */
const textPartArb: fc.Arbitrary<ContentPart> = nonEmptyString.map((text) => ({
  type: 'text' as const,
  text,
}));

/** ImageUrlPart arbitrary. */
const imageUrlPartArb: fc.Arbitrary<ContentPart> = urlString.map((url) => ({
  type: 'image_url' as const,
  image_url: { url },
}));

/** FilePart WITH file_data (inline base64). */
const filePartWithDataArb: fc.Arbitrary<ContentPart> = fc
  .tuple(
    fc.base64String({ minLength: 4, maxLength: 200 }),
    fc.string({ minLength: 1, maxLength: 60 }),
  )
  .map(([data, filename]) => ({
    type: 'file' as const,
    file: { filename, file_data: data },
  }));

/** FilePart WITHOUT file_data (no inline bytes, no file_id). */
const filePartNoDataArb: fc.Arbitrary<ContentPart> = fc
  .string({ minLength: 1, maxLength: 60 })
  .map((filename) => ({
    type: 'file' as const,
    file: { filename },
  }));

/** Any valid ContentPart. */
const anyPartArb: fc.Arbitrary<ContentPart> = fc.oneof(
  textPartArb,
  imageUrlPartArb,
  filePartWithDataArb,
  filePartNoDataArb,
);

// ── Tests ───────────────────────────────────────────────────────

describe('GoogleGeminiProvider — multimodal content mapping', () => {

  // ── Shared SDK for simple, non-concurrent unit tests ───────────

  let generateContentFn: jest.Mock<any>;
  let provider: GoogleGeminiProvider;

  beforeEach(() => {
    const sdk = createMockSDK();
    generateContentFn = sdk.generateContentFn;
    generateContentFn.mockResolvedValue(geminiSuccess());
    provider = new GoogleGeminiProvider(baseConfig(), sdk.MockGoogleGenerativeAI as any);
  });

  // ── Property 8: string content pass-through ──────────────────────
  // Feature: multimodal-content-and-responses-api, Property 8: string content pass-through

  describe('Property 8: string content produces exactly one {text} part', () => {

    it('example: plain string produces [{text: content}]', async () => {
      const message: ChatMessage = { role: 'user', content: 'Hello, Gemini!' };
      await provider.complete([message], { model: 'gemini-1.5-pro' });
      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      expect(contents).toHaveLength(1);
      expect(contents[0]!.parts).toEqual([{ text: 'Hello, Gemini!' }]);
    });

    it('example: empty string produces [{text: ""}]', async () => {
      const message: ChatMessage = { role: 'user', content: '' };
      await provider.complete([message], { model: 'gemini-1.5-pro' });
      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      expect(contents[0]!.parts).toEqual([{ text: '' }]);
    });

    // **Validates: Requirements 6.1**
    it('property: any string content produces exactly one {text: s} part', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ maxLength: 500 }),
          fc.constantFrom('user' as const, 'assistant' as const),
          async (s, role) => {
            const contents = await captureContents([{ role, content: s }]);

            // Exactly one part — the original string
            expect(contents).toHaveLength(1);
            expect(contents[0]!.parts).toHaveLength(1);
            expect(contents[0]!.parts[0]).toEqual({ text: s });
          },
        ),
        { numRuns: 200 },
      );
    });

    // **Validates: Requirements 6.1**
    it('property: role is correctly mapped for string content messages', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ maxLength: 200 }),
          fc.constantFrom('user' as const, 'assistant' as const),
          async (s, role) => {
            const contents = await captureContents([{ role, content: s }]);
            const expectedRole = role === 'assistant' ? 'model' : 'user';
            expect(contents[0]!.role).toBe(expectedRole);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── Property 9: TextPart and ImageUrlPart mapping ─────────────────
  // Feature: multimodal-content-and-responses-api, Property 9: TextPart and ImageUrlPart mapping

  describe('Property 9: TextPart and ImageUrlPart are mapped correctly', () => {

    it('example: single TextPart produces [{text: part.text}]', async () => {
      const part: ContentPart = { type: 'text', text: 'Hello from part' };
      const message: ChatMessage = { role: 'user', content: [part] };
      await provider.complete([message], { model: 'gemini-1.5-pro' });

      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      expect(contents[0]!.parts).toEqual([{ text: 'Hello from part' }]);
    });

    it('example: single ImageUrlPart produces [{fileData: {mimeType: "image/*", fileUri: url}}]', async () => {
      const part: ContentPart = { type: 'image_url', image_url: { url: 'https://example.com/img.png' } };
      const message: ChatMessage = { role: 'user', content: [part] };
      await provider.complete([message], { model: 'gemini-1.5-pro' });

      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      expect(contents[0]!.parts).toEqual([
        { fileData: { mimeType: 'image/*', fileUri: 'https://example.com/img.png' } },
      ]);
    });

    // **Validates: Requirements 6.2**
    it('property: every TextPart maps to {text: part.text}', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(textPartArb, { minLength: 1, maxLength: 10 }),
          async (parts) => {
            const contents = await captureContents([{ role: 'user', content: parts }]);
            const geminiParts = contents[0]!.parts;

            expect(geminiParts).toHaveLength(parts.length);
            for (let i = 0; i < parts.length; i++) {
              const p = parts[i]! as { type: 'text'; text: string };
              expect(geminiParts[i]).toEqual({ text: p.text });
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    // **Validates: Requirements 6.3**
    it('property: every ImageUrlPart maps to {fileData: {mimeType: "image/*", fileUri: url}}', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(imageUrlPartArb, { minLength: 1, maxLength: 10 }),
          async (parts) => {
            const contents = await captureContents([{ role: 'user', content: parts }]);
            const geminiParts = contents[0]!.parts;

            expect(geminiParts).toHaveLength(parts.length);
            for (let i = 0; i < parts.length; i++) {
              const p = parts[i]! as { type: 'image_url'; image_url: { url: string } };
              expect(geminiParts[i]).toEqual({
                fileData: { mimeType: 'image/*', fileUri: p.image_url.url },
              });
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    // **Validates: Requirements 6.2, 6.3**
    it('property: mixed TextPart and ImageUrlPart arrays preserve order and mapping', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.oneof(textPartArb, imageUrlPartArb), { minLength: 1, maxLength: 8 }),
          async (parts) => {
            const contents = await captureContents([{ role: 'user', content: parts }]);
            const geminiParts = contents[0]!.parts as Array<Record<string, unknown>>;

            expect(geminiParts).toHaveLength(parts.length);
            for (let i = 0; i < parts.length; i++) {
              const src = parts[i]!;
              if (src.type === 'text') {
                expect(geminiParts[i]).toEqual({ text: (src as { type: 'text'; text: string }).text });
              } else {
                const img = src as { type: 'image_url'; image_url: { url: string } };
                expect(geminiParts[i]).toEqual({
                  fileData: { mimeType: 'image/*', fileUri: img.image_url.url },
                });
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── FilePart with file_data → inlineData ─────────────────────────
  // **Validates: Requirements 6.4**

  describe('FilePart with file_data → inlineData', () => {

    it('example: FilePart with file_data produces [{inlineData: {mimeType, data}}]', async () => {
      const part: ContentPart = {
        type: 'file',
        file: { filename: 'doc.pdf', file_data: 'SGVsbG8=' },
      };
      const message: ChatMessage = { role: 'user', content: [part] };
      await provider.complete([message], { model: 'gemini-1.5-pro' });

      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      expect(contents[0]!.parts).toEqual([
        { inlineData: { mimeType: 'application/octet-stream', data: 'SGVsbG8=' } },
      ]);
    });

    it('property: FilePart with file_data always maps to {inlineData} with correct data', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(filePartWithDataArb, { minLength: 1, maxLength: 5 }),
          async (parts) => {
            const contents = await captureContents([{ role: 'user', content: parts }]);
            const geminiParts = contents[0]!.parts as Array<Record<string, unknown>>;

            expect(geminiParts).toHaveLength(parts.length);
            for (let i = 0; i < parts.length; i++) {
              const fp = parts[i]! as { type: 'file'; file: { file_data: string } };
              expect(geminiParts[i]).toEqual({
                inlineData: {
                  mimeType: 'application/octet-stream',
                  data: fp.file.file_data,
                },
              });
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── FilePart without file_data → omitted ─────────────────────────
  // **Validates: Requirements 6.4**

  describe('FilePart without file_data → omitted from parts', () => {

    it('example: FilePart without file_data is omitted (falls back to [{text:""}])', async () => {
      const part: ContentPart = {
        type: 'file',
        file: { filename: 'ghost.pdf' },
      };
      const message: ChatMessage = { role: 'user', content: [part] };
      await provider.complete([message], { model: 'gemini-1.5-pro' });

      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      // No file_data → omitted → fallback empty text part
      expect(contents[0]!.parts).toEqual([{ text: '' }]);
    });

    it('example: FilePart without file_data mixed with TextPart — only TextPart survives', async () => {
      const parts: ContentPart[] = [
        { type: 'text', text: 'See attached:' },
        { type: 'file', file: { filename: 'report.pdf' } },
      ];
      const message: ChatMessage = { role: 'user', content: parts };
      await provider.complete([message], { model: 'gemini-1.5-pro' });

      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      // Only the text part survives; no-data FilePart silently omitted
      expect(contents[0]!.parts).toEqual([{ text: 'See attached:' }]);
    });

    // **Validates: Requirements 6.4**
    it('property: FilePart without file_data is silently omitted from output parts', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(filePartNoDataArb, { minLength: 1, maxLength: 5 }),
          async (parts) => {
            const contents = await captureContents([{ role: 'user', content: parts }]);
            const geminiParts = contents[0]!.parts as Array<Record<string, unknown>>;

            // All parts have no file_data → all omitted → fallback [{text:''}]
            expect(geminiParts).toEqual([{ text: '' }]);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: mixing no-data FileParts with TextParts — only TextParts appear in output', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(textPartArb, { minLength: 1, maxLength: 5 }),
          fc.array(filePartNoDataArb, { minLength: 1, maxLength: 5 }),
          async (textParts, fileParts) => {
            // Interleave the two arrays so order varies
            const mixed: ContentPart[] = [...textParts, ...fileParts].sort(() => 0);

            const contents = await captureContents([{ role: 'user', content: mixed }]);
            const geminiParts = contents[0]!.parts as Array<Record<string, unknown>>;

            // Only text parts should survive; count matches textParts.length
            expect(geminiParts).toHaveLength(textParts.length);
            for (const gp of geminiParts) {
              expect(gp).toHaveProperty('text');
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── All-parts-omitted fallback → [{text: ''}] ────────────────────
  // **Validates: Requirements 10.3**

  describe('All-parts-omitted fallback → single empty text part', () => {

    it('example: empty ContentPart array produces [{text: ""}]', async () => {
      const message: ChatMessage = { role: 'user', content: [] };
      await provider.complete([message], { model: 'gemini-1.5-pro' });

      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      expect(contents[0]!.parts).toEqual([{ text: '' }]);
    });

    // **Validates: Requirements 10.3**
    it('property: any array composed solely of no-data FileParts always falls back to [{text:""}]', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(filePartNoDataArb, { minLength: 1, maxLength: 10 }),
          async (parts) => {
            const contents = await captureContents([{ role: 'user', content: parts }]);
            expect(contents[0]!.parts).toEqual([{ text: '' }]);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: empty ContentPart array for any non-system role always falls back to [{text:""}]', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('user' as const, 'assistant' as const),
          async (role) => {
            const contents = await captureContents([{ role, content: [] }]);
            expect(contents[0]!.parts).toEqual([{ text: '' }]);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ── Mixed multimodal message (all part types together) ────────────
  // **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

  describe('Mixed multimodal messages', () => {

    it('example: TextPart + ImageUrlPart + FilePart-with-data in one message', async () => {
      const parts: ContentPart[] = [
        { type: 'text', text: 'See image:' },
        { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
        { type: 'file', file: { filename: 'report.pdf', file_data: 'AAAA' } },
      ];
      const message: ChatMessage = { role: 'user', content: parts };
      await provider.complete([message], { model: 'gemini-1.5-pro' });

      const callArg = generateContentFn.mock.calls[0]![0] as Record<string, unknown>;
      const contents = callArg['contents'] as Array<{ role: string; parts: unknown[] }>;

      expect(contents[0]!.parts).toEqual([
        { text: 'See image:' },
        { fileData: { mimeType: 'image/*', fileUri: 'https://example.com/photo.jpg' } },
        { inlineData: { mimeType: 'application/octet-stream', data: 'AAAA' } },
      ]);
    });

    // **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
    it('property: part-order is preserved across TextPart + ImageUrlPart + FilePart-with-data', async () => {
      // Arb: only parts that produce output (TextPart, ImageUrlPart, FilePart-with-data)
      const outputPartArb = fc.oneof(textPartArb, imageUrlPartArb, filePartWithDataArb);

      await fc.assert(
        fc.asyncProperty(
          fc.array(outputPartArb, { minLength: 1, maxLength: 8 }),
          async (parts) => {
            const contents = await captureContents([{ role: 'user', content: parts }]);
            const geminiParts = contents[0]!.parts as Array<Record<string, unknown>>;

            expect(geminiParts).toHaveLength(parts.length);

            for (let i = 0; i < parts.length; i++) {
              const src = parts[i]!;
              const out = geminiParts[i]!;

              if (src.type === 'text') {
                expect(out).toEqual({ text: (src as { type: 'text'; text: string }).text });
              } else if (src.type === 'image_url') {
                const img = src as { type: 'image_url'; image_url: { url: string } };
                expect(out).toEqual({
                  fileData: { mimeType: 'image/*', fileUri: img.image_url.url },
                });
              } else {
                const fp = src as { type: 'file'; file: { file_data: string } };
                expect(out).toEqual({
                  inlineData: { mimeType: 'application/octet-stream', data: fp.file.file_data },
                });
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('property: no-data FileParts are silently dropped within a mixed array', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.oneof(textPartArb, imageUrlPartArb, filePartNoDataArb), { minLength: 1, maxLength: 8 }),
          async (parts) => {
            const contents = await captureContents([{ role: 'user', content: parts }]);
            const geminiParts = contents[0]!.parts as Array<Record<string, unknown>>;

            // Count expected output parts (only TextPart and ImageUrlPart produce output)
            const expectedCount = parts.filter(
              (p) => p.type === 'text' || p.type === 'image_url',
            ).length;

            if (expectedCount === 0) {
              // All were no-data FileParts → fallback
              expect(geminiParts).toEqual([{ text: '' }]);
            } else {
              expect(geminiParts).toHaveLength(expectedCount);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ── Multi-message conversations ──────────────────────────────────
  // **Validates: Requirements 6.5**

  describe('Multi-message conversations with multimodal content', () => {

    it('property: each message in a conversation is independently mapped', async () => {
      // Arb: array of messages, each with ContentPart[] content
      const multimodalMessageArb = fc.record({
        role: fc.constantFrom('user' as const, 'assistant' as const),
        content: fc.array(fc.oneof(textPartArb, imageUrlPartArb), { minLength: 1, maxLength: 4 }),
      });

      await fc.assert(
        fc.asyncProperty(
          fc.array(multimodalMessageArb, { minLength: 1, maxLength: 5 }),
          async (messages: ChatMessage[]) => {
            const contents = await captureContents(messages);

            expect(contents).toHaveLength(messages.length);

            for (let mi = 0; mi < messages.length; mi++) {
              const msg = messages[mi]!;
              const msgParts = msg.content as ContentPart[];
              const geminiParts = contents[mi]!.parts as Array<Record<string, unknown>>;

              expect(geminiParts).toHaveLength(msgParts.length);

              // Verify role mapping
              const expectedRole = msg.role === 'assistant' ? 'model' : 'user';
              expect(contents[mi]!.role).toBe(expectedRole);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
