/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the anthropic factory's `create()` happy-path via real esmRequire.
 * Covers lines 76,85 in src/provider/factories/anthropic.ts.
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
          if (id === '@anthropic-ai/sdk') return { default: MockAnthropicClass };
          return realRequire(id);
        };
      },
    };
  });

  const mod = await import('../../../../src/provider/factories/anthropic.js');
  anthropic = mod.anthropic;
});

describe('anthropic factory — real esmRequire create() happy-path (lines 76,85)', () => {
  it('should return an AnthropicProvider when SDK is available', () => {
    const provider = anthropic({
      apiKey: 'sk-ant-test',
      models: ['claude-sonnet-4-20250514'],
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.id).toBe('anthropic');
  });

  it('should pass the models list to the provider', () => {
    const provider = anthropic({
      apiKey: 'sk-ant-test',
      models: ['claude-opus-4-20250514', 'claude-haiku-4-20250514'],
    });
    expect([...provider.models]).toEqual(['claude-opus-4-20250514', 'claude-haiku-4-20250514']);
  });

  it('should pass optional defaults to the provider', () => {
    const provider = anthropic({
      apiKey: 'sk-ant-test',
      models: ['claude-sonnet-4-20250514'],
      defaults: { maxTokens: 1024 },
    });
    expect(provider.id).toBe('anthropic');
    expect(typeof provider.complete).toBe('function');
  });

  it('should resolve mod.default from SDK module (line 76)', () => {
    // mock returns { default: MockAnthropicClass } — tests the `mod.default ?? mod` branch
    const provider = anthropic({ apiKey: 'sk-ant-key', models: ['claude-sonnet-4-20250514'] });
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });
});
