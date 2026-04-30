/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the real anthropic factory's SDK loading branch.
 *
 * These tests exercise the actual `esmRequire('@anthropic-ai/sdk')` call path
 * in `src/provider/factories/anthropic.ts` by mocking `node:module`'s
 * `createRequire` to simulate the SDK not being installed.
 *
 * This covers the catch block (line ~75) in the real factory source,
 * which is not reachable via the local `createAnthropicFactory` helper
 * used in the main test file.
 *
 * **Validates: Requirements 4.5, 9.3, 10.4**
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import type { BridgeError as BridgeErrorType } from '../../../../src/errors/BridgeError.js';

// ── Module-level variables populated in beforeAll ───────────────

let anthropic: typeof import('../../../../src/provider/factories/anthropic.js').anthropic;
let BridgeError: typeof BridgeErrorType;

// ── ESM mock setup: createRequire throws for '@anthropic-ai/sdk' ─

beforeAll(async () => {
  // Mock node:module so that createRequire returns a function
  // that throws for the '@anthropic-ai/sdk' package (simulating SDK not installed)
  jest.unstable_mockModule('node:module', () => {
    const realModule = jest.requireActual('node:module') as typeof import('node:module');
    const realCreateRequire = realModule.createRequire;

    return {
      ...realModule,
      createRequire: (url: string | URL) => {
        const realRequire = realCreateRequire(url);
        return (id: string) => {
          if (id === '@anthropic-ai/sdk') {
            throw new Error(`Cannot find module '@anthropic-ai/sdk'`);
          }
          return realRequire(id);
        };
      },
    };
  });

  // Dynamic imports AFTER mock setup — the factory module will
  // pick up the mocked createRequire at load time
  const factoryMod = await import('../../../../src/provider/factories/anthropic.js');
  const errorMod = await import('../../../../src/errors/BridgeError.js');

  anthropic = factoryMod.anthropic;
  BridgeError = errorMod.BridgeError;
});

// ── Tests ───────────────────────────────────────────────────────

describe('anthropic factory — SDK loading branch', () => {
  it('should throw BridgeError CONFIG when require("@anthropic-ai/sdk") fails', () => {
    expect(() => anthropic({
      apiKey: 'sk-ant-test-key',
      models: ['claude-sonnet-4-20250514'],
    })).toThrow(BridgeError);
  });

  it('should include installation instruction in the error message', () => {
    try {
      anthropic({ apiKey: 'sk-ant-test-key', models: ['claude-sonnet-4-20250514'] });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      const bridgeErr = err as InstanceType<typeof BridgeError>;
      expect(bridgeErr.type).toBe('CONFIG');
      expect(bridgeErr.message).toContain('@anthropic-ai/sdk');
      expect(bridgeErr.message).toContain('npm install @anthropic-ai/sdk');
    }
  });

  it('should include providerId in error details', () => {
    try {
      anthropic({ apiKey: 'sk-ant-test-key', models: ['claude-sonnet-4-20250514'] });
      expect(true).toBe(false);
    } catch (err) {
      const bridgeErr = err as InstanceType<typeof BridgeError>;
      expect(bridgeErr.details).toHaveProperty('providerId', 'anthropic');
    }
  });

  it('should still validate options via Zod before attempting SDK load', () => {
    // Empty apiKey should fail Zod validation BEFORE reaching the require() call
    try {
      anthropic({ apiKey: '', models: ['claude-sonnet-4-20250514'] });
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
