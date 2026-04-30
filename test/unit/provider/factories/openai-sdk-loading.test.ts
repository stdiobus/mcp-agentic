/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the real openAI factory's SDK loading branch.
 *
 * These tests exercise the actual `esmRequire('openai')` call path
 * in `src/provider/factories/openai.ts` by mocking `node:module`'s
 * `createRequire` to simulate the SDK not being installed.
 *
 * This covers the catch block (line ~75) in the real factory source,
 * which is not reachable via the local `createOpenAIFactory` helper
 * used in the main test file.
 *
 * **Validates: Requirements 3.5, 9.3, 10.4**
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import type { BridgeError as BridgeErrorType } from '../../../../src/errors/BridgeError.js';

// ── Module-level variables populated in beforeAll ───────────────

let openAI: typeof import('../../../../src/provider/factories/openai.js').openAI;
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
  const factoryMod = await import('../../../../src/provider/factories/openai.js');
  const errorMod = await import('../../../../src/errors/BridgeError.js');

  openAI = factoryMod.openAI;
  BridgeError = errorMod.BridgeError;
});

// ── Tests ───────────────────────────────────────────────────────

describe('openAI factory — SDK loading branch', () => {
  it('should throw BridgeError CONFIG when require("openai") fails', () => {
    expect(() => openAI({
      apiKey: 'sk-test-key',
      models: ['gpt-4o'],
    })).toThrow(BridgeError);
  });

  it('should include installation instruction in the error message', () => {
    try {
      openAI({ apiKey: 'sk-test-key', models: ['gpt-4o'] });
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

  it('should include providerId in error details', () => {
    try {
      openAI({ apiKey: 'sk-test-key', models: ['gpt-4o'] });
      expect(true).toBe(false);
    } catch (err) {
      const bridgeErr = err as InstanceType<typeof BridgeError>;
      expect(bridgeErr.details).toHaveProperty('providerId', 'openai');
    }
  });

  it('should still validate options via Zod before attempting SDK load', () => {
    // Empty apiKey should fail Zod validation BEFORE reaching the require() call
    try {
      openAI({ apiKey: '', models: ['gpt-4o'] });
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
