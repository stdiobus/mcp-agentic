/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers branch line 76 in gemini.ts: `mod.GoogleGenerativeAI ?? mod.default`
 * — the right-hand side `?? mod.default` taken when SDK has no `.GoogleGenerativeAI`.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import { GoogleGeminiProvider } from '../../../../src/provider/providers/GoogleGeminiProvider.js';

let gemini: typeof import('../../../../src/provider/factories/gemini.js').gemini;

beforeAll(async () => {
  const MockGoogleGenerativeAI = class {
    readonly apiKey: string;
    getGenerativeModel = jest.fn<any>().mockReturnValue({
      generateContent: jest.fn<any>(),
    });
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
          if (id === '@google/generative-ai') {
            // No `.GoogleGenerativeAI` — forces `mod.GoogleGenerativeAI ?? mod.default`
            // to take the right-hand `mod.default` path
            return { default: MockGoogleGenerativeAI };
          }
          return realRequire(id);
        };
      },
    };
  });

  const mod = await import('../../../../src/provider/factories/gemini.js');
  gemini = mod.gemini;
});

describe('gemini factory — mod.GoogleGenerativeAI ?? mod.default branch (line 76, right-hand side)', () => {
  it('should create GoogleGeminiProvider when SDK exports via .default instead of .GoogleGenerativeAI', () => {
    const provider = gemini({ apiKey: 'AIza-test', models: ['gemini-2.0-flash'] });
    expect(provider).toBeInstanceOf(GoogleGeminiProvider);
    expect(provider.id).toBe('google-gemini');
  });
});
