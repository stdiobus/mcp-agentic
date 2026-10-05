/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers branch line 76 in openai.ts: `mod.default ?? mod`
 * — the right-hand side `?? mod` taken when SDK exports without `.default`.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import { OpenAIProvider } from '../../../../src/provider/providers/OpenAIProvider.js';

let openAI: typeof import('../../../../src/provider/factories/openai.js').openAI;

beforeAll(async () => {
  // SDK module has NO `.default` — only the class itself as the module value
  const MockOpenAIClass = class {
    readonly apiKey: string;
    readonly chat = { completions: { create: jest.fn<any>() } };
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
          if (id === 'openai') {
            // Return without `.default` — forces `mod.default ?? mod` to use `mod`
            return MockOpenAIClass;
          }
          return realRequire(id);
        };
      },
    };
  });

  const mod = await import('../../../../src/provider/factories/openai.js');
  openAI = mod.openAI;
});

describe('openAI factory — mod.default ?? mod branch (line 76, right-hand side)', () => {
  it('should create OpenAIProvider when SDK exports without .default', () => {
    const provider = openAI({ apiKey: 'sk-test', models: ['gpt-4o'] });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.id).toBe('openai');
  });
});
