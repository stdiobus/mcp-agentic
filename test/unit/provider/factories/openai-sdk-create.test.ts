/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the openAI factory's `create()` happy-path via real esmRequire.
 *
 * Mocks `node:module.createRequire` to return a valid mock OpenAI SDK class,
 * then imports the real factory and exercises its `create()` branch (lines 76,85).
 *
 * Must be a separate file because `jest.unstable_mockModule` must be called
 * at module scope (in a top-level `beforeAll`) before the factory is imported.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import { OpenAIProvider } from '../../../../src/provider/providers/OpenAIProvider.js';

let openAI: typeof import('../../../../src/provider/factories/openai.js').openAI;

beforeAll(async () => {
  // Mock node:module so createRequire returns a fn that returns a mock OpenAI SDK
  jest.unstable_mockModule('node:module', () => {
    const real = jest.requireActual('node:module') as typeof import('node:module');
    const realCreateRequire = real.createRequire;

    // Minimal mock SDK class — enough for OpenAIProvider constructor
    const MockOpenAIClass = class {
      readonly apiKey: string;
      readonly chat = { completions: { create: jest.fn<any>() } };
      constructor(opts: { apiKey: string }) { this.apiKey = opts.apiKey; }
    };

    return {
      ...real,
      createRequire: (url: string | URL) => {
        const realRequire = realCreateRequire(url);
        return (id: string) => {
          if (id === 'openai') return { default: MockOpenAIClass };
          return realRequire(id);
        };
      },
    };
  });

  const mod = await import('../../../../src/provider/factories/openai.js');
  openAI = mod.openAI;
});

describe('openAI factory — real esmRequire create() happy-path (lines 76,85)', () => {
  it('should return an OpenAIProvider when SDK is available', () => {
    const provider = openAI({ apiKey: 'sk-test', models: ['gpt-4o'] });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.id).toBe('openai');
  });

  it('should pass the models list to the provider', () => {
    const provider = openAI({ apiKey: 'sk-test', models: ['gpt-4o', 'gpt-4o-mini'] });
    expect([...provider.models]).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('should pass optional defaults to the provider', () => {
    const provider = openAI({ apiKey: 'sk-test', models: ['gpt-4o'], defaults: { temperature: 0.5 } });
    expect(provider.id).toBe('openai');
    expect(typeof provider.complete).toBe('function');
  });

  it('should pick up mod.default when SDK exports default', () => {
    // Already covered by the mock returning { default: MockOpenAIClass }
    // This verifies the `mod.default ?? mod` branch (line 76)
    const provider = openAI({ apiKey: 'sk-key', models: ['gpt-4o-mini'] });
    expect(provider).toBeInstanceOf(OpenAIProvider);
  });
});
