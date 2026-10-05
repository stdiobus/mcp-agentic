/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers branch line 76 in anthropic.ts: `mod.default ?? mod`
 * — the right-hand side `?? mod` taken when SDK exports without `.default`.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import { AnthropicProvider } from '../../../../src/provider/providers/AnthropicProvider.js';

let anthropic: typeof import('../../../../src/provider/factories/anthropic.js').anthropic;

beforeAll(async () => {
  const MockAnthropicClass = class {
    readonly apiKey: string;
    readonly messages = { create: jest.fn<any>() };
    constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
  };

  jest.unstable_mockModule('node:module', () => {
    const real = jest.requireActual('node:module') as typeof import('node:module');
    const realCreateRequire = real.createRequire;
    return {
      ...real,
      createRequire: (url: string | URL) => {
        const realRequire = realCreateRequire(url);
        return (id: string) => {
          if (id === '@anthropic-ai/sdk') return MockAnthropicClass;
          return realRequire(id);
        };
      },
    };
  });

  const mod = await import('../../../../src/provider/factories/anthropic.js');
  anthropic = mod.anthropic;
});

describe('anthropic factory — mod.default ?? mod branch (line 76, right-hand side)', () => {
  it('should create AnthropicProvider when SDK exports without .default', () => {
    const provider = anthropic({
      apiKey: 'sk-ant-test',
      models: ['claude-sonnet-4-20250514'],
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.id).toBe('anthropic');
  });
});
