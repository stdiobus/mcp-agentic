/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the real gemini factory's SDK loading branch.
 *
 * These tests exercise the actual `esmRequire('@google/generative-ai')` call path
 * in `src/provider/factories/gemini.ts` by mocking `node:module`'s
 * `createRequire` to simulate the SDK not being installed.
 *
 * This covers the catch block (line ~75) in the real factory source,
 * which is not reachable via the local `createGeminiFactory` helper
 * used in the main test file.
 *
 * **Validates: Requirements 5.5, 9.3, 10.4**
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import type { BridgeError as BridgeErrorType } from '../../../../src/errors/BridgeError.js';

// ── Module-level variables populated in beforeAll ───────────────

let gemini: typeof import('../../../../src/provider/factories/gemini.js').gemini;
let BridgeError: typeof BridgeErrorType;

// ── ESM mock setup: createRequire throws for '@google/generative-ai' ─

beforeAll(async () => {
  // Mock node:module so that createRequire returns a function
  // that throws for the '@google/generative-ai' package (simulating SDK not installed)
  jest.unstable_mockModule('node:module', () => {
    const realModule = jest.requireActual('node:module') as typeof import('node:module');
    const realCreateRequire = realModule.createRequire;

    return {
      ...realModule,
      createRequire: (url: string | URL) => {
        const realRequire = realCreateRequire(url);
        return (id: string) => {
          if (id === '@google/generative-ai') {
            throw new Error(`Cannot find module '@google/generative-ai'`);
          }
          return realRequire(id);
        };
      },
    };
  });

  // Dynamic imports AFTER mock setup — the factory module will
  // pick up the mocked createRequire at load time
  const factoryMod = await import('../../../../src/provider/factories/gemini.js');
  const errorMod = await import('../../../../src/errors/BridgeError.js');

  gemini = factoryMod.gemini;
  BridgeError = errorMod.BridgeError;
});

// ── Tests ───────────────────────────────────────────────────────

describe('gemini factory — SDK loading branch', () => {
  it('should throw BridgeError CONFIG when require("@google/generative-ai") fails', () => {
    expect(() => gemini({
      apiKey: 'AIza-test-key',
      models: ['gemini-2.0-flash'],
    })).toThrow(BridgeError);
  });

  it('should include installation instruction in the error message', () => {
    try {
      gemini({ apiKey: 'AIza-test-key', models: ['gemini-2.0-flash'] });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      const bridgeErr = err as InstanceType<typeof BridgeError>;
      expect(bridgeErr.type).toBe('CONFIG');
      expect(bridgeErr.message).toContain('@google/generative-ai');
      expect(bridgeErr.message).toContain('npm install @google/generative-ai');
    }
  });

  it('should include providerId in error details', () => {
    try {
      gemini({ apiKey: 'AIza-test-key', models: ['gemini-2.0-flash'] });
      expect(true).toBe(false);
    } catch (err) {
      const bridgeErr = err as InstanceType<typeof BridgeError>;
      expect(bridgeErr.details).toHaveProperty('providerId', 'google-gemini');
    }
  });

  it('should still validate options via Zod before attempting SDK load', () => {
    // Empty apiKey should fail Zod validation BEFORE reaching the require() call
    try {
      gemini({ apiKey: '', models: ['gemini-2.0-flash'] });
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
