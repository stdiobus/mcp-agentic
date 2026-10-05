/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers branch line 86 in openai-responses.ts: `mod.default ?? mod`
 * — the right-hand side `?? mod` taken when SDK exports without `.default`.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import { OpenAIResponsesProvider } from '../../../../src/provider/providers/OpenAIResponsesProvider.js';

let openAIResponses: typeof import('../../../../src/provider/factories/openai-responses.js').openAIResponses;

beforeAll(async () => {
  const MockOpenAIClass = class {
    readonly apiKey: string;
    readonly responses = { create: jest.fn<any>() };
    readonly files = { create: jest.fn<any>(), delete: jest.fn<any>() };
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
          if (id === 'openai') return MockOpenAIClass; // no .default
          return realRequire(id);
        };
      },
    };
  });

  const mod = await import('../../../../src/provider/factories/openai-responses.js');
  openAIResponses = mod.openAIResponses;
});

describe('openAIResponses factory — mod.default ?? mod branch (line 86, right-hand side)', () => {
  it('should create OpenAIResponsesProvider when SDK exports without .default', () => {
    const provider = openAIResponses({ apiKey: 'sk-test', models: ['gpt-4o'] });
    expect(provider).toBeInstanceOf(OpenAIResponsesProvider);
    expect(provider.id).toBe('openai-responses');
    expect(provider.capabilities?.files).toBe(true);
  });
});
