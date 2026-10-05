/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers branch line 234 in OpenAIResponsesProvider.ts:
 *   `err instanceof Error ? err : undefined`
 * — the `: undefined` side when the `catch` block receives a non-Error thrown value.
 *
 * This happens when `import('openai')` throws something that is NOT an Error instance
 * (e.g. a plain string, number, or object without prototype chain from Error).
 *
 * Must be a separate file: mock is set at module scope via `jest.unstable_mockModule`.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';

let OpenAIResponsesProvider: typeof import(
  '../../../../src/provider/providers/OpenAIResponsesProvider.js'
).OpenAIResponsesProvider;
let BridgeError: typeof import(
  '../../../../src/errors/BridgeError.js'
).BridgeError;

// Mock openai so that importing it throws a non-Error value (plain string).
// This forces the `catch` in static create() to hit:
//   `err instanceof Error ? err : undefined`  →  undefined (line 234 right branch)
jest.unstable_mockModule('openai', () => {
  // Throwing inside a module factory simulates import() failure with a non-Error
  // eslint-disable-next-line @typescript-eslint/no-throw-literal
  throw 'openai module not available'; // plain string, not an Error
});

beforeAll(async () => {
  const providerMod = await import(
    '../../../../src/provider/providers/OpenAIResponsesProvider.js'
  );
  const errorMod = await import('../../../../src/errors/BridgeError.js');
  OpenAIResponsesProvider = providerMod.OpenAIResponsesProvider;
  BridgeError = errorMod.BridgeError;
});

describe('OpenAIResponsesProvider.create() — non-Error throw in catch (line 234 ?: undefined branch)', () => {
  it('should throw BridgeError CONFIG with undefined cause when caught value is not an Error', async () => {
    const err = await OpenAIResponsesProvider.create({
      credentials: { apiKey: 'sk-test' },
      models: ['gpt-4o'],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    expect((err as typeof BridgeError.prototype).type).toBe('CONFIG');
    expect((err as typeof BridgeError.prototype).message).toContain('npm install openai');
    // cause is undefined because thrown value was not an Error instance (line 234 right branch)
    expect((err as typeof BridgeError.prototype).cause).toBeUndefined();
  });
});
