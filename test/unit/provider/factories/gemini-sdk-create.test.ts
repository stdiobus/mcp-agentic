/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the gemini factory's `create()` happy-path via real esmRequire.
 * Covers lines 76,85 in src/provider/factories/gemini.ts.
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
            // gemini.ts uses: mod.GoogleGenerativeAI ?? mod.default
            return { GoogleGenerativeAI: MockGoogleGenerativeAI };
          }
          return realRequire(id);
        };
      },
    };
  });

  const mod = await import('../../../../src/provider/factories/gemini.js');
  gemini = mod.gemini;
});

describe('gemini factory — real esmRequire create() happy-path (lines 76,85)', () => {
  it('should return a GoogleGeminiProvider when SDK is available', () => {
    const provider = gemini({ apiKey: 'AIza-test', models: ['gemini-2.0-flash'] });
    expect(provider).toBeInstanceOf(GoogleGeminiProvider);
    expect(provider.id).toBe('google-gemini');
  });

  it('should pass the models list to the provider', () => {
    const provider = gemini({
      apiKey: 'AIza-test',
      models: ['gemini-2.0-flash', 'gemini-1.5-pro'],
    });
    expect([...provider.models]).toEqual(['gemini-2.0-flash', 'gemini-1.5-pro']);
  });

  it('should pass optional defaults to the provider', () => {
    const provider = gemini({
      apiKey: 'AIza-test',
      models: ['gemini-2.0-flash'],
      defaults: { temperature: 0.3 },
    });
    expect(provider.id).toBe('google-gemini');
    expect(typeof provider.complete).toBe('function');
  });

  it('should resolve GoogleGenerativeAI from SDK module named export (line 76)', () => {
    // mock returns { GoogleGenerativeAI: MockClass } — tests `mod.GoogleGenerativeAI ?? mod.default`
    const provider = gemini({ apiKey: 'AIza-key', models: ['gemini-2.0-flash'] });
    expect(provider).toBeInstanceOf(GoogleGeminiProvider);
  });
});
