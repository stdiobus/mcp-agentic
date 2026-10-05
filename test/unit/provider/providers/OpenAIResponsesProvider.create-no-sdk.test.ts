/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `OpenAIResponsesProvider.static async create()` when the openai
 * package is not installed (line 231 — the SDK-missing catch branch).
 *
 * Must be a separate file: `jest.unstable_mockModule('openai')` must be called
 * at top-level before the provider module is imported.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';

let OpenAIResponsesProvider: typeof import('../../../../src/provider/providers/OpenAIResponsesProvider.js').OpenAIResponsesProvider;
let BridgeError: typeof import('../../../../src/errors/BridgeError.js').BridgeError;

beforeAll(async () => {
  // Make `import('openai')` throw — simulates package not installed
  jest.unstable_mockModule('openai', () => {
    throw new Error("Cannot find module 'openai'");
  });

  const providerMod = await import(
    '../../../../src/provider/providers/OpenAIResponsesProvider.js'
  );
  const errorMod = await import('../../../../src/errors/BridgeError.js');

  OpenAIResponsesProvider = providerMod.OpenAIResponsesProvider;
  BridgeError = errorMod.BridgeError;
});

describe('OpenAIResponsesProvider.create() — SDK not installed (line 231)', () => {
  it('should throw BridgeError CONFIG when openai package is missing', async () => {
    const err = await OpenAIResponsesProvider.create({
      credentials: { apiKey: 'sk-test' },
      models: ['gpt-4o'],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as typeof BridgeError.prototype).type).toBe('CONFIG');
    expect((err as typeof BridgeError.prototype).message).toContain('npm install openai');
    expect((err as typeof BridgeError.prototype).details['providerId']).toBe('openai-responses');
  });
});
