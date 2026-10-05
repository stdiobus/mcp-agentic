/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `OpenAIResponsesProvider` constructor error paths,
 * `static async create()`, and `complete()` edge cases.
 *
 * Covers lines not reached by the main mapping test file:
 *   - 191: constructor throws CONFIG when apiKey is missing/empty
 *   - 203: constructor throws CONFIG when no SDK is injected
 *   - 222-231: static async create() — success path via mock and SDK-missing path
 *   - 258: complete() throws UPSTREAM when no model is configured
 *   - 278: complete() passes AbortSignal to responses.create
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { OpenAIResponsesProvider } from '../../../../src/provider/providers/OpenAIResponsesProvider.js';
import { BridgeError } from '../../../../src/errors/BridgeError.js';
import type { ProviderConfig } from '../../../../src/provider/AIProvider.js';

// ── Mock SDK factory ─────────────────────────────────────────────

function makeMockSDK() {
  const responsesCreate = jest.fn<any>().mockResolvedValue({
    output_text: 'hello',
    status: 'completed',
    usage: { input_tokens: 5, output_tokens: 3 },
  });
  const filesCreate = jest.fn<any>();
  const filesDelete = jest.fn<any>();

  class MockOpenAI {
    readonly apiKey: string;
    readonly responses = { create: responsesCreate };
    readonly files = { create: filesCreate, delete: filesDelete };
    constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
  }

  return { MockOpenAI, responsesCreate, filesCreate, filesDelete };
}

function validConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return { credentials: { apiKey: 'sk-test' }, models: ['gpt-4o'], ...overrides };
}

// ── Constructor error paths ──────────────────────────────────────

describe('OpenAIResponsesProvider — constructor error paths', () => {
  it('should throw BridgeError CONFIG when apiKey credential is absent (line 191)', () => {
    const { MockOpenAI } = makeMockSDK();

    expect(() =>
      new OpenAIResponsesProvider({ credentials: {}, models: ['gpt-4o'] }, MockOpenAI as any),
    ).toThrow(BridgeError);

    try {
      new OpenAIResponsesProvider({ credentials: {}, models: ['gpt-4o'] }, MockOpenAI as any);
    } catch (err) {
      expect((err as BridgeError).type).toBe('CONFIG');
      expect((err as BridgeError).message).toContain('apiKey');
      expect((err as BridgeError).details['providerId']).toBe('openai-responses');
    }
  });

  it('should throw BridgeError CONFIG when apiKey is an empty string (line 191)', () => {
    const { MockOpenAI } = makeMockSDK();

    expect(() =>
      new OpenAIResponsesProvider(
        { credentials: { apiKey: '' }, models: ['gpt-4o'] },
        MockOpenAI as any,
      ),
    ).toThrow(BridgeError);

    try {
      new OpenAIResponsesProvider(
        { credentials: { apiKey: '' }, models: ['gpt-4o'] },
        MockOpenAI as any,
      );
    } catch (err) {
      expect((err as BridgeError).type).toBe('CONFIG');
    }
  });

  it('should throw BridgeError CONFIG when no SDK is injected (line 203)', () => {
    expect(() =>
      new OpenAIResponsesProvider(validConfig()),
    ).toThrow(BridgeError);

    try {
      new OpenAIResponsesProvider(validConfig());
    } catch (err) {
      expect((err as BridgeError).type).toBe('CONFIG');
      expect((err as BridgeError).message).toContain('openai');
      expect((err as BridgeError).details['providerId']).toBe('openai-responses');
    }
  });
});

// ── static async create() ────────────────────────────────────────
// The `openai` package is mocked via test/__mocks__/openai.ts — dynamic import
// resolves to the mock SDK, making the happy-path reachable without real credentials.

describe('OpenAIResponsesProvider — static async create() (lines 222-231)', () => {
  it('should construct provider via static create() using the mocked openai package', async () => {
    const provider = await OpenAIResponsesProvider.create(validConfig());
    expect(provider).toBeInstanceOf(OpenAIResponsesProvider);
    expect(provider.id).toBe('openai-responses');
    expect([...provider.models]).toEqual(['gpt-4o']);
  });

  it('should rethrow BridgeError thrown by constructor (missing apiKey path, line 226)', async () => {
    // Constructor throws BridgeError.config for empty apiKey;
    // static create() re-throws it via `if (err instanceof BridgeError) throw err`
    const err = await OpenAIResponsesProvider.create({
      credentials: { apiKey: '' },
      models: ['gpt-4o'],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('CONFIG');
    expect((err as BridgeError).message).toContain('apiKey');
  });

  it('should include defaults when provided to static create()', async () => {
    const provider = await OpenAIResponsesProvider.create({
      credentials: { apiKey: 'sk-test' },
      models: ['gpt-4o'],
      defaults: { temperature: 0.5 },
    });
    expect(provider.id).toBe('openai-responses');
  });
});

// ── complete() edge cases ────────────────────────────────────────

describe('OpenAIResponsesProvider — complete() edge cases', () => {
  it('should throw BridgeError UPSTREAM when no model is in params or defaults (line 258)', async () => {
    const { MockOpenAI } = makeMockSDK();
    // Deliberately no default model
    const provider = new OpenAIResponsesProvider(
      { credentials: { apiKey: 'sk-test' }, models: ['gpt-4o'] },
      MockOpenAI as any,
    );

    const err = await provider
      .complete([{ role: 'user', content: 'hi' }], {})
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('UPSTREAM');
    expect((err as BridgeError).message).toContain('No model specified');
    expect((err as BridgeError).details['providerId']).toBe('openai-responses');
  });

  it('should forward AbortSignal to responses.create (line 278)', async () => {
    const { MockOpenAI, responsesCreate } = makeMockSDK();
    const provider = new OpenAIResponsesProvider(validConfig(), MockOpenAI as any);

    const controller = new AbortController();
    await provider.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'gpt-4o' },
      controller.signal,
    );

    const callOpts = responsesCreate.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(callOpts?.signal).toBe(controller.signal);
  });

  it('should NOT set signal option when no AbortSignal is passed (line 278 branch not taken)', async () => {
    const { MockOpenAI, responsesCreate } = makeMockSDK();
    const provider = new OpenAIResponsesProvider(validConfig(), MockOpenAI as any);

    await provider.complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' });

    const callOpts = responsesCreate.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
    expect(callOpts?.signal).toBeUndefined();
  });
});

// ── complete() response field ?? branches (lines 283-291) ────────

describe('OpenAIResponsesProvider — complete() response field fallbacks', () => {
  function makeProvider() {
    const { MockOpenAI, responsesCreate } = makeMockSDK();
    const provider = new OpenAIResponsesProvider(
      { credentials: { apiKey: 'sk-test' }, models: ['gpt-4o'] },
      MockOpenAI as any,
    );
    return { provider, responsesCreate };
  }

  it('should use empty string when output_text is absent (line 283 ?? branch)', async () => {
    const { provider, responsesCreate } = makeProvider();
    // Response without output_text — triggers `response.output_text ?? ''`
    responsesCreate.mockResolvedValueOnce({
      status: 'completed',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const result = await provider.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'gpt-4o' },
    );
    expect(result.text).toBe('');
  });

  it('should use "unknown" when status is absent (line 284 ?? branch)', async () => {
    const { provider, responsesCreate } = makeProvider();
    // Response without status — triggers `response.status ?? 'unknown'`
    responsesCreate.mockResolvedValueOnce({ output_text: 'hello' });
    const result = await provider.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'gpt-4o' },
    );
    // 'unknown' is not in STOP_REASON_MAP, so stopReason === 'unknown'
    expect(result.stopReason).toBe('unknown');
  });

  it('should use nativeStatus as stopReason when not in STOP_REASON_MAP (line 285 ?? branch)', async () => {
    const { provider, responsesCreate } = makeProvider();
    responsesCreate.mockResolvedValueOnce({
      output_text: 'hello',
      status: 'some_future_status',
    });
    const result = await provider.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'gpt-4o' },
    );
    expect(result.stopReason).toBe('some_future_status');
  });

  it('should use 0 when input_tokens is absent in usage (line 290 ?? branch)', async () => {
    const { provider, responsesCreate } = makeProvider();
    // usage present but input_tokens absent — triggers `?? 0`
    responsesCreate.mockResolvedValueOnce({
      output_text: 'hello',
      status: 'completed',
      usage: { output_tokens: 5 },
    });
    const result = await provider.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'gpt-4o' },
    );
    expect(result.usage?.inputTokens).toBe(0);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it('should use 0 when output_tokens is absent in usage (line 291 ?? branch)', async () => {
    const { provider, responsesCreate } = makeProvider();
    responsesCreate.mockResolvedValueOnce({
      output_text: 'hello',
      status: 'completed',
      usage: { input_tokens: 10 },
    });
    const result = await provider.complete(
      [{ role: 'user', content: 'hi' }],
      { model: 'gpt-4o' },
    );
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(0);
  });
});

// ── mapError() and mapUpstreamError() non-Error throw branches ────
// Lines 501-502 (mapUpstreamError) and 534-535 (mapError)

describe('OpenAIResponsesProvider — mapError / mapUpstreamError non-Error throw branches', () => {
  function makeProvider() {
    const { MockOpenAI, responsesCreate, filesCreate, filesDelete } = makeMockSDK();
    const provider = new OpenAIResponsesProvider(
      { credentials: { apiKey: 'sk-test' }, models: ['gpt-4o'] },
      MockOpenAI as any,
    );
    return { provider, responsesCreate, filesCreate, filesDelete };
  }

  // Line 534-535: mapError — err is NOT an Error instance (plain object / string)
  it('should wrap a plain-object throw in BridgeError UPSTREAM (line 534-535)', async () => {
    const { provider, responsesCreate } = makeProvider();
    // Throw a plain object — not an Error instance
    responsesCreate.mockRejectedValueOnce({ message: 'plain object error' });

    const err = await provider
      .complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).message).toBe('plain object error');
  });

  it('should use String(err) when thrown value has no message (line 501/534 ?? branch)', async () => {
    const { provider, responsesCreate } = makeProvider();
    // Throw a value with no message property
    responsesCreate.mockRejectedValueOnce({ code: 42 });

    const err = await provider
      .complete([{ role: 'user', content: 'hi' }], { model: 'gpt-4o' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    // message falls back to String({ code: 42 }) = '[object Object]'
    expect(typeof (err as BridgeError).message).toBe('string');
  });

  // Lines 501-502: mapUpstreamError — err is NOT an Error instance
  it('should wrap a plain-object throw from FilesAPI in BridgeError UPSTREAM (lines 501-502)', async () => {
    const { provider, filesCreate } = makeProvider();
    // Throw a plain object from files.create
    filesCreate.mockRejectedValueOnce({ message: 'upload failed' });

    const err = await provider.files.create({
      filename: 'test.txt',
      content: 'hello',
      mimeType: 'text/plain',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('UPSTREAM');
    expect((err as BridgeError).message).toBe('upload failed');
  });

  it('should use String(err) for FilesAPI when thrown value has no message (line 501 ?? branch)', async () => {
    const { provider, filesDelete } = makeProvider();
    filesDelete.mockRejectedValueOnce('string error');

    const err = await provider.files.delete('file-123').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).type).toBe('UPSTREAM');
  });
});

// ── static create() openaiModule.default ?? openaiModule branch ──
// Line 225: covered by OpenAIResponsesProvider.create-no-sdk.test.ts for the
// SDK-missing path. The `?? openaiModule` branch (no .default) requires a
// separate module-level mock — handled in openai-responses-sdk-create-no-default.test.ts.
// This test verifies static create() also resolves correctly when mock has .default.
describe('OpenAIResponsesProvider — static create() with openaiModule.default ?? openaiModule (line 225)', () => {
  it('should use openaiModule.default when present (left side of ?? in static create())', async () => {
    // The standard mock has .default — exercises the left side
    const provider = await OpenAIResponsesProvider.create({
      credentials: { apiKey: 'sk-test' },
      models: ['gpt-4o'],
    });
    expect(provider).toBeInstanceOf(OpenAIResponsesProvider);
  });
});
