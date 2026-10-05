/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the openAIResponses factory's SDK loading branch.
 *
 * These tests exercise the actual `esmRequire('openai')` call path
 * in `src/provider/factories/openai-responses.ts` by mocking `node:module`'s
 * `createRequire` to simulate the SDK not being installed.
 *
 * This covers the catch block in the real factory source, which is not
 * reachable via the standard mock since the mock is already installed.
 *
 * **Validates: Requirements 7.10, 8.4**
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import type { BridgeError as BridgeErrorType } from '../../../../src/errors/BridgeError.js';

// ── Module-level variables populated in beforeAll ───────────────

let openAIResponses: typeof import('../../../../src/provider/factories/openai-responses.js').openAIResponses;
let BridgeError: typeof BridgeErrorType;

// ── ESM mock setup: createRequire throws for 'openai' ──────────

beforeAll(async () => {
  // Mock node:module so that createRequire returns a function
  // that throws for the 'openai' package (simulating SDK not installed)
  jest.unstable_mockModule('node:module', () => {
    const realModule = jest.requireActual('node:module') as typeof import('node:module');
    const realCreateRequire = realModule.createRequire;

    return {
      ...realModule,
      createRequire: (url: string | URL) => {
        const realRequire = realCreateRequire(url);
        return (id: string) => {
          if (id === 'openai') {
            throw new Error(`Cannot find module 'openai'`);
          }
          return realRequire(id);
        };
      },
    };
  });

  // Dynamic imports AFTER mock setup — the factory module will
  // pick up the mocked createRequire at load time
  const factoryMod = await import('../../../../src/provider/factories/openai-responses.js');
  const errorMod = await import('../../../../src/errors/BridgeError.js');

  openAIResponses = factoryMod.openAIResponses;
  BridgeError = errorMod.BridgeError;
});

// ── Tests ───────────────────────────────────────────────────────

describe('openAIResponses factory — SDK loading branch', () => {
  it('should throw BridgeError CONFIG when require("openai") fails', () => {
    expect(() => openAIResponses({
      apiKey: 'sk-test-key',
      models: ['gpt-4o'],
    })).toThrow(BridgeError);
  });

  it('should include npm install openai in the error message', () => {
    try {
      openAIResponses({ apiKey: 'sk-test-key', models: ['gpt-4o'] });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      const bridgeErr = err as InstanceType<typeof BridgeError>;
      expect(bridgeErr.type).toBe('CONFIG');
      expect(bridgeErr.message).toContain('openai');
      expect(bridgeErr.message).toContain('npm install openai');
    }
  });

  it('should include providerId openai-responses in error details', () => {
    try {
      openAIResponses({ apiKey: 'sk-test-key', models: ['gpt-4o'] });
      expect(true).toBe(false);
    } catch (err) {
      const bridgeErr = err as InstanceType<typeof BridgeError>;
      expect(bridgeErr.details).toHaveProperty('providerId', 'openai-responses');
    }
  });

  it('should validate options via Zod before SDK load (empty apiKey → CONFIG with apiKey in message)', () => {
    // Empty apiKey should fail Zod validation BEFORE reaching the require() call
    try {
      openAIResponses({ apiKey: '', models: ['gpt-4o'] });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      const bridgeErr = err as InstanceType<typeof BridgeError>;
      expect(bridgeErr.type).toBe('CONFIG');
      // Zod error mentions apiKey, not SDK installation
      expect(bridgeErr.message).toContain('apiKey');
      expect(bridgeErr.message).not.toContain('npm install');
    }
  });
});
