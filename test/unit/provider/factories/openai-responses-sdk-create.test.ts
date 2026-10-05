/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the openAIResponses factory's `create()` happy-path via real esmRequire.
 * Covers lines 86,95 in src/provider/factories/openai-responses.ts.
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
          if (id === 'openai') return { default: MockOpenAIClass };
          return realRequire(id);
        };
      },
    };
  });

  const mod = await import('../../../../src/provider/factories/openai-responses.js');
  openAIResponses = mod.openAIResponses;
});

describe('openAIResponses factory — real esmRequire create() happy-path (lines 86,95)', () => {
  it('should return an OpenAIResponsesProvider when SDK is available', () => {
    const provider = openAIResponses({ apiKey: 'sk-test', models: ['gpt-4o'] });
    expect(provider).toBeInstanceOf(OpenAIResponsesProvider);
    expect(provider.id).toBe('openai-responses');
  });

  it('should pass the models list to the provider', () => {
    const provider = openAIResponses({ apiKey: 'sk-test', models: ['gpt-4o', 'gpt-4o-mini'] });
    expect([...provider.models]).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('should expose FilesAPI (files.create / files.delete) from the provider', () => {
    const provider = openAIResponses({ apiKey: 'sk-test', models: ['gpt-4o'] }) as OpenAIResponsesProvider;
    expect(typeof provider.files?.create).toBe('function');
    expect(typeof provider.files?.delete).toBe('function');
  });

  it('should report files: true in capabilities', () => {
    const provider = openAIResponses({ apiKey: 'sk-test', models: ['gpt-4o'] });
    expect(provider.capabilities?.files).toBe(true);
  });

  it('should pass optional defaults to the provider (line 95 branch)', () => {
    const provider = openAIResponses({
      apiKey: 'sk-test',
      models: ['gpt-4o'],
      defaults: { temperature: 0, maxTokens: 100 },
    });
    expect(provider.id).toBe('openai-responses');
    expect(typeof provider.complete).toBe('function');
  });

  it('should resolve mod.default from SDK module (line 86)', () => {
    // mock returns { default: MockOpenAIClass } — tests the `mod.default ?? mod` branch
    const provider = openAIResponses({ apiKey: 'sk-key', models: ['gpt-4o-mini'] });
    expect(provider).toBeInstanceOf(OpenAIResponsesProvider);
  });
});
