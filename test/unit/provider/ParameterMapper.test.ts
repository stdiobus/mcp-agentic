/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit and property-based tests for ParameterMapper.
 *
 * Tests cover:
 * - Profile resolution hierarchy (default → prefix → exact)
 * - Parameter renaming for each provider's profiles
 * - OpenAI model-aware maxTokens mapping (gpt-4o → max_tokens, gpt-5 → max_completion_tokens)
 * - Anthropic default mapping
 * - Gemini default mapping
 * - Determinism property
 * - Specificity property (more specific profile always wins)
 *
 * **Validates: Requirements 1.5, 1.6, 3.3, 3.4**
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import type { ModelProfile } from '../../../src/provider/ParameterMapper.js';
import { mapParameters } from '../../../src/provider/ParameterMapper.js';
import type { RuntimeParams } from '../../../src/provider/AIProvider.js';

// ── Provider profile definitions (mirrors production code) ──────

/**
 * OpenAI profiles — same structure as in OpenAIProvider.ts.
 * Default uses modern `max_completion_tokens`; legacy prefixes override to `max_tokens`.
 */
const OPENAI_PROFILES: readonly ModelProfile[] = [
  {
    match: 'default',
    renames: {
      temperature: 'temperature',
      maxTokens: 'max_completion_tokens',
      topP: 'top_p',
      stopSequences: 'stop',
    },
    exclude: ['topK'],
  },
  { match: 'prefix', pattern: 'gpt-4o', renames: { maxTokens: 'max_tokens' } },
  { match: 'prefix', pattern: 'gpt-4', renames: { maxTokens: 'max_tokens' } },
  { match: 'prefix', pattern: 'gpt-3.5', renames: { maxTokens: 'max_tokens' } },
];

/** Anthropic profiles — same structure as in AnthropicProvider.ts. */
const ANTHROPIC_PROFILES: readonly ModelProfile[] = [
  {
    match: 'default',
    renames: {
      temperature: 'temperature',
      maxTokens: 'max_tokens',
      topP: 'top_p',
      topK: 'top_k',
      stopSequences: 'stop_sequences',
    },
    defaults: { max_tokens: 1024 },
  },
];

/** Gemini profiles — same structure as in GoogleGeminiProvider.ts. */
const GEMINI_PROFILES: readonly ModelProfile[] = [
  {
    match: 'default',
    renames: {
      temperature: 'temperature',
      maxTokens: 'maxOutputTokens',
      topP: 'topP',
      topK: 'topK',
      stopSequences: 'stopSequences',
    },
  },
];

// ── fast-check arbitraries ──────────────────────────────────────

const runtimeParamsArb: fc.Arbitrary<RuntimeParams> = fc.record(
  {
    temperature: fc.option(fc.double({ min: 0, max: 2, noNaN: true }), { nil: undefined }),
    maxTokens: fc.option(fc.integer({ min: 1, max: 100000 }), { nil: undefined }),
    topP: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
    topK: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    stopSequences: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 3 }), { nil: undefined }),
  },
  { requiredKeys: [] },
);

const modelArb = fc.constantFrom(
  'gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo',
  'gpt-5', 'gpt-5.1', 'gpt-5.4-mini', 'o1', 'o3', 'o3-mini', 'o4-mini',
  'claude-sonnet-4-20250514', 'gemini-1.5-pro', 'custom-model',
);

// ── Tests ───────────────────────────────────────────────────────

describe('ParameterMapper', () => {

  // ── Profile resolution hierarchy ──────────────────────────────

  describe('profile resolution hierarchy', () => {
    it('should use default profile when no other profiles match', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'max_output' } },
      ];
      const result = mapParameters(profiles, 'unknown-model', { maxTokens: 100 });
      expect(result).toEqual({ max_output: 100 });
    });

    it('should prefer prefix match over default', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'default_name' } },
        { match: 'prefix', pattern: 'gpt-4', renames: { maxTokens: 'prefix_name' } },
      ];
      const result = mapParameters(profiles, 'gpt-4-turbo', { maxTokens: 100 });
      expect(result).toEqual({ prefix_name: 100 });
    });

    it('should prefer exact match over prefix match', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'default_name' } },
        { match: 'prefix', pattern: 'gpt-4', renames: { maxTokens: 'prefix_name' } },
        { match: 'exact', pattern: 'gpt-4-turbo', renames: { maxTokens: 'exact_name' } },
      ];
      const result = mapParameters(profiles, 'gpt-4-turbo', { maxTokens: 100 });
      expect(result).toEqual({ exact_name: 100 });
    });

    it('should prefer longer prefix over shorter prefix', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'default_name' } },
        { match: 'prefix', pattern: 'gpt-4', renames: { maxTokens: 'short_prefix' } },
        { match: 'prefix', pattern: 'gpt-4-turbo', renames: { maxTokens: 'long_prefix' } },
      ];
      const result = mapParameters(profiles, 'gpt-4-turbo-preview', { maxTokens: 100 });
      expect(result).toEqual({ long_prefix: 100 });
    });

    it('should not match prefix when next character is alphanumeric', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'default_name' } },
        { match: 'prefix', pattern: 'gpt-4', renames: { maxTokens: 'gpt4_name' } },
      ];
      // 'gpt-4o' — next char after 'gpt-4' is 'o' (alphanumeric) → should NOT match
      const result = mapParameters(profiles, 'gpt-4o', { maxTokens: 100 });
      expect(result).toEqual({ default_name: 100 });
    });

    it('should match prefix when model equals prefix exactly', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'default_name' } },
        { match: 'prefix', pattern: 'gpt-4', renames: { maxTokens: 'gpt4_name' } },
      ];
      const result = mapParameters(profiles, 'gpt-4', { maxTokens: 100 });
      expect(result).toEqual({ gpt4_name: 100 });
    });

    it('should be case-insensitive for matching', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'default_name' } },
        { match: 'prefix', pattern: 'gpt-4', renames: { maxTokens: 'gpt4_name' } },
      ];
      const result = mapParameters(profiles, 'GPT-4-Turbo', { maxTokens: 100 });
      expect(result).toEqual({ gpt4_name: 100 });
    });
  });

  // ── Exclude and defaults ──────────────────────────────────────

  describe('exclude and defaults', () => {
    it('should exclude specified parameters', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { topK: 'top_k', temperature: 'temperature' }, exclude: ['topK'] },
      ];
      const result = mapParameters(profiles, 'model', { topK: 40, temperature: 0.7 });
      expect(result).toEqual({ temperature: 0.7 });
      expect(result).not.toHaveProperty('top_k');
    });

    it('should apply defaults when parameter is undefined', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'max_tokens' }, defaults: { max_tokens: 1024 } },
      ];
      const result = mapParameters(profiles, 'model', {});
      expect(result).toEqual({ max_tokens: 1024 });
    });

    it('should not apply defaults when parameter is defined', () => {
      const profiles: ModelProfile[] = [
        { match: 'default', renames: { maxTokens: 'max_tokens' }, defaults: { max_tokens: 1024 } },
      ];
      const result = mapParameters(profiles, 'model', { maxTokens: 2048 });
      expect(result).toEqual({ max_tokens: 2048 });
    });
  });

  // ── OpenAI model-aware mapping ────────────────────────────────

  describe('OpenAI model-aware mapping', () => {
    it('gpt-4o → max_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-4o', { maxTokens: 100 });
      expect(result['max_tokens']).toBe(100);
      expect(result['max_completion_tokens']).toBeUndefined();
    });

    it('gpt-4o-mini → max_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-4o-mini', { maxTokens: 100 });
      expect(result['max_tokens']).toBe(100);
      expect(result['max_completion_tokens']).toBeUndefined();
    });

    it('gpt-4 → max_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-4', { maxTokens: 100 });
      expect(result['max_tokens']).toBe(100);
    });

    it('gpt-4-turbo → max_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-4-turbo', { maxTokens: 100 });
      expect(result['max_tokens']).toBe(100);
    });

    it('gpt-3.5-turbo → max_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-3.5-turbo', { maxTokens: 100 });
      expect(result['max_tokens']).toBe(100);
    });

    it('gpt-5 → max_completion_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-5', { maxTokens: 100 });
      expect(result['max_completion_tokens']).toBe(100);
      expect(result['max_tokens']).toBeUndefined();
    });

    it('gpt-5.5 → max_completion_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-5.5', { maxTokens: 100 });
      expect(result['max_completion_tokens']).toBe(100);
      expect(result['max_tokens']).toBeUndefined();
    });

    it('o3 → max_completion_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'o3', { maxTokens: 100 });
      expect(result['max_completion_tokens']).toBe(100);
      expect(result['max_tokens']).toBeUndefined();
    });

    it('o3-mini → max_completion_tokens', () => {
      const result = mapParameters(OPENAI_PROFILES, 'o3-mini', { maxTokens: 100 });
      expect(result['max_completion_tokens']).toBe(100);
    });

    it('should exclude topK for OpenAI models', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-4', { topK: 40, temperature: 0.7 });
      expect(result).not.toHaveProperty('topK');
      expect(result).not.toHaveProperty('top_k');
      expect(result['temperature']).toBe(0.7);
    });

    it('should map topP → top_p and stopSequences → stop', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-4', {
        topP: 0.9,
        stopSequences: ['END'],
      });
      expect(result['top_p']).toBe(0.9);
      expect(result['stop']).toEqual(['END']);
    });

    it('should not include undefined parameters', () => {
      const result = mapParameters(OPENAI_PROFILES, 'gpt-4', {});
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  // ── Anthropic default mapping ─────────────────────────────────

  describe('Anthropic default mapping', () => {
    it('should map all parameters correctly', () => {
      const result = mapParameters(ANTHROPIC_PROFILES, 'claude-sonnet-4-20250514', {
        temperature: 0.7,
        maxTokens: 2048,
        topP: 0.9,
        topK: 40,
        stopSequences: ['END'],
      });
      expect(result).toEqual({
        temperature: 0.7,
        max_tokens: 2048,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ['END'],
      });
    });

    it('should apply default max_tokens of 1024 when not specified', () => {
      const result = mapParameters(ANTHROPIC_PROFILES, 'claude-sonnet-4-20250514', {});
      expect(result).toEqual({ max_tokens: 1024 });
    });

    it('should override default max_tokens when specified', () => {
      const result = mapParameters(ANTHROPIC_PROFILES, 'claude-sonnet-4-20250514', { maxTokens: 4096 });
      expect(result['max_tokens']).toBe(4096);
    });
  });

  // ── Gemini default mapping ────────────────────────────────────

  describe('Gemini default mapping', () => {
    it('should map all parameters correctly', () => {
      const result = mapParameters(GEMINI_PROFILES, 'gemini-1.5-pro', {
        temperature: 0.7,
        maxTokens: 2048,
        topP: 0.9,
        topK: 40,
        stopSequences: ['END'],
      });
      expect(result).toEqual({
        temperature: 0.7,
        maxOutputTokens: 2048,
        topP: 0.9,
        topK: 40,
        stopSequences: ['END'],
      });
    });

    it('should not include undefined parameters', () => {
      const result = mapParameters(GEMINI_PROFILES, 'gemini-1.5-pro', {});
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  // ── Property tests ────────────────────────────────────────────

  describe('property tests', () => {
    /**
     * **Validates: Requirements 1.5, 1.6**
     *
     * Property: mapping is deterministic — same input always produces same output.
     */
    it('property: mapping is deterministic (same input → same output)', () => {
      const profileSets = [OPENAI_PROFILES, ANTHROPIC_PROFILES, GEMINI_PROFILES];

      fc.assert(
        fc.property(
          fc.constantFrom(...profileSets),
          modelArb,
          runtimeParamsArb,
          (profiles, model, params) => {
            const result1 = mapParameters(profiles, model, params);
            const result2 = mapParameters(profiles, model, params);
            expect(result1).toEqual(result2);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 1.5, 1.6**
     *
     * Property: more specific profile always wins over less specific.
     * If an exact match profile defines a rename, it overrides prefix and default.
     */
    it('property: more specific profile always wins over less specific', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.integer({ min: 1, max: 10000 }),
          (modelName, maxTokens) => {
            const profiles: ModelProfile[] = [
              { match: 'default', renames: { maxTokens: 'default_param' } },
              { match: 'exact', pattern: modelName, renames: { maxTokens: 'exact_param' } },
            ];
            const result = mapParameters(profiles, modelName, { maxTokens });
            // Exact match should always win
            expect(result['exact_param']).toBe(maxTokens);
            expect(result['default_param']).toBeUndefined();
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 3.3, 3.4**
     *
     * Property: for any OpenAI model, exactly one of max_tokens or
     * max_completion_tokens is set when maxTokens is provided.
     */
    it('property: OpenAI models get exactly one maxTokens variant', () => {
      const allModels = [
        'gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo',
        'gpt-5', 'gpt-5.1', 'o1', 'o3', 'o3-mini', 'o4-mini', 'custom-model',
      ];
      const legacyModels = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo']);

      fc.assert(
        fc.property(
          fc.constantFrom(...allModels),
          fc.integer({ min: 1, max: 100000 }),
          (model, maxTokens) => {
            const result = mapParameters(OPENAI_PROFILES, model, { maxTokens });
            const hasMaxTokens = result['max_tokens'] !== undefined;
            const hasMaxCompletionTokens = result['max_completion_tokens'] !== undefined;

            // Exactly one must be set
            expect(hasMaxTokens !== hasMaxCompletionTokens).toBe(true);

            // Legacy → max_tokens, modern → max_completion_tokens
            if (legacyModels.has(model)) {
              expect(hasMaxTokens).toBe(true);
            } else {
              expect(hasMaxCompletionTokens).toBe(true);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
