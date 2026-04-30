/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based and unit tests for mergeRuntimeParams.
 *
 * Tests cover:
 * - Property 5: RuntimeParams merge priority
 *   (prompt > session > config for all fields, shallow merge for providerSpecific)
 *
 * Validates: Requirements 6.4, 6.5, 6.6
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { mergeRuntimeParams } from '../../../src/provider/AIProvider.js';
import type { RuntimeParams } from '../../../src/provider/AIProvider.js';

// ── fast-check arbitraries ──────────────────────────────────────

/** Arbitrary for optional string fields (model, systemPrompt). */
const arbOptionalString = fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined });

/** Arbitrary for optional temperature (0–2). */
const arbOptionalTemperature = fc.option(
  fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
  { nil: undefined },
);

/** Arbitrary for optional maxTokens (positive int). */
const arbOptionalMaxTokens = fc.option(fc.integer({ min: 1, max: 100000 }), { nil: undefined });

/** Arbitrary for optional topP (0–1). */
const arbOptionalTopP = fc.option(
  fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  { nil: undefined },
);

/** Arbitrary for optional topK (positive int). */
const arbOptionalTopK = fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined });

/** Arbitrary for optional stopSequences. */
const arbOptionalStopSequences = fc.option(
  fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 5 }),
  { nil: undefined },
);

/** Arbitrary for optional providerSpecific record. */
const arbOptionalProviderSpecific = fc.option(
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { minKeys: 1, maxKeys: 5 },
  ),
  { nil: undefined },
);

/** Arbitrary for a full RuntimeParams object with all fields optional. */
const arbRuntimeParams: fc.Arbitrary<RuntimeParams> = fc.record({
  model: arbOptionalString,
  temperature: arbOptionalTemperature,
  maxTokens: arbOptionalMaxTokens,
  topP: arbOptionalTopP,
  topK: arbOptionalTopK,
  stopSequences: arbOptionalStopSequences,
  systemPrompt: arbOptionalString,
  providerSpecific: arbOptionalProviderSpecific,
});

// ── Tests ───────────────────────────────────────────────────────

describe('mergeRuntimeParams', () => {
  // ── Property 5: RuntimeParams merge priority ────────────────────

  describe('Property 5: RuntimeParams merge priority', () => {
    // Feature: multi-provider-agents, Property 5: RuntimeParams merge priority
    it('property: prompt-level values take highest priority over session and config', () => {
      fc.assert(
        fc.property(
          arbRuntimeParams,
          arbRuntimeParams,
          arbRuntimeParams,
          (configDefaults, sessionParams, promptParams) => {
            const merged = mergeRuntimeParams(configDefaults, sessionParams, promptParams);

            // For each scalar field, the merged value must equal the highest-priority defined value
            const scalarKeys = [
              'model', 'temperature', 'maxTokens', 'topP', 'topK', 'stopSequences', 'systemPrompt',
            ] as const;

            for (const key of scalarKeys) {
              const expected = promptParams[key] ?? sessionParams[key] ?? configDefaults[key];
              if (expected !== undefined) {
                if (merged[key] !== expected) return false;
              } else {
                if (merged[key] !== undefined) return false;
              }
            }

            return true;
          },
        ),
        { numRuns: 200 },
      );
    });

    // Feature: multi-provider-agents, Property 5: RuntimeParams merge priority
    it('property: providerSpecific is shallow-merged across all layers', () => {
      fc.assert(
        fc.property(
          arbRuntimeParams,
          arbRuntimeParams,
          arbRuntimeParams,
          (configDefaults, sessionParams, promptParams) => {
            const merged = mergeRuntimeParams(configDefaults, sessionParams, promptParams);

            const hasAny =
              configDefaults.providerSpecific !== undefined ||
              sessionParams.providerSpecific !== undefined ||
              promptParams.providerSpecific !== undefined;

            if (!hasAny) {
              // No providerSpecific at any level → should be absent
              return merged.providerSpecific === undefined;
            }

            // providerSpecific should be the shallow merge of all layers
            const expected = {
              ...configDefaults.providerSpecific,
              ...sessionParams.providerSpecific,
              ...promptParams.providerSpecific,
            };

            // Check all keys match
            const mergedPS = merged.providerSpecific ?? {};
            const expectedKeys = Object.keys(expected);
            const mergedKeys = Object.keys(mergedPS);

            if (expectedKeys.length !== mergedKeys.length) return false;

            for (const key of expectedKeys) {
              if (mergedPS[key] !== expected[key]) return false;
            }

            return true;
          },
        ),
        { numRuns: 200 },
      );
    });

    // Feature: multi-provider-agents, Property 5: RuntimeParams merge priority
    it('property: undefined fields do not override values from lower-priority layers', () => {
      fc.assert(
        fc.property(
          arbRuntimeParams,
          arbRuntimeParams,
          (configDefaults, sessionParams) => {
            // Prompt params with all undefined (empty object)
            const promptParams: RuntimeParams = {};
            const merged = mergeRuntimeParams(configDefaults, sessionParams, promptParams);

            // Result should be equivalent to merging just config + session
            const expected = mergeRuntimeParams(configDefaults, sessionParams);

            const scalarKeys = [
              'model', 'temperature', 'maxTokens', 'topP', 'topK', 'stopSequences', 'systemPrompt',
            ] as const;

            for (const key of scalarKeys) {
              if (merged[key] !== expected[key]) return false;
            }

            // providerSpecific comparison
            const mergedPS = merged.providerSpecific;
            const expectedPS = expected.providerSpecific;
            if (mergedPS === undefined && expectedPS === undefined) return true;
            if (mergedPS === undefined || expectedPS === undefined) return false;

            const mergedKeys = Object.keys(mergedPS);
            const expectedKeys = Object.keys(expectedPS);
            if (mergedKeys.length !== expectedKeys.length) return false;
            for (const key of mergedKeys) {
              if (mergedPS[key] !== expectedPS[key]) return false;
            }

            return true;
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ── Unit tests: specific examples and edge cases ────────────────

  describe('unit: specific examples', () => {
    it('should return empty object when all inputs are empty', () => {
      const result = mergeRuntimeParams({}, {}, {});
      expect(result).toEqual({});
    });

    it('should return empty object when called with no arguments', () => {
      const result = mergeRuntimeParams();
      expect(result).toEqual({});
    });

    it('should use config defaults when no overrides are provided', () => {
      const config: RuntimeParams = { model: 'gpt-4', temperature: 0.7, maxTokens: 1000 };
      const result = mergeRuntimeParams(config, {}, {});

      expect(result.model).toBe('gpt-4');
      expect(result.temperature).toBe(0.7);
      expect(result.maxTokens).toBe(1000);
    });

    it('should override config with session params', () => {
      const config: RuntimeParams = { model: 'gpt-4', temperature: 0.7 };
      const session: RuntimeParams = { model: 'gpt-3.5-turbo' };
      const result = mergeRuntimeParams(config, session, {});

      expect(result.model).toBe('gpt-3.5-turbo');
      expect(result.temperature).toBe(0.7); // Not overridden
    });

    it('should override session with prompt params', () => {
      const config: RuntimeParams = { model: 'gpt-4', temperature: 0.7 };
      const session: RuntimeParams = { model: 'gpt-3.5-turbo', temperature: 0.5 };
      const prompt: RuntimeParams = { temperature: 1.0 };
      const result = mergeRuntimeParams(config, session, prompt);

      expect(result.model).toBe('gpt-3.5-turbo'); // From session
      expect(result.temperature).toBe(1.0); // From prompt (highest priority)
    });

    it('should shallow-merge providerSpecific across all layers', () => {
      const config: RuntimeParams = {
        providerSpecific: { frequency_penalty: 0.5, presence_penalty: 0.3 },
      };
      const session: RuntimeParams = {
        providerSpecific: { frequency_penalty: 0.8, logprobs: true },
      };
      const prompt: RuntimeParams = {
        providerSpecific: { frequency_penalty: 1.0 },
      };
      const result = mergeRuntimeParams(config, session, prompt);

      expect(result.providerSpecific).toEqual({
        frequency_penalty: 1.0,  // From prompt (highest priority)
        presence_penalty: 0.3,   // From config (only source)
        logprobs: true,          // From session (only source)
      });
    });

    it('should not include providerSpecific when none of the layers define it', () => {
      const config: RuntimeParams = { model: 'gpt-4' };
      const session: RuntimeParams = { temperature: 0.5 };
      const prompt: RuntimeParams = { maxTokens: 500 };
      const result = mergeRuntimeParams(config, session, prompt);

      expect(result.providerSpecific).toBeUndefined();
    });

    it('should handle systemPrompt override at prompt level', () => {
      const config: RuntimeParams = { systemPrompt: 'You are a helpful assistant.' };
      const session: RuntimeParams = {};
      const prompt: RuntimeParams = { systemPrompt: 'You are a code reviewer.' };
      const result = mergeRuntimeParams(config, session, prompt);

      expect(result.systemPrompt).toBe('You are a code reviewer.');
    });

    it('should handle stopSequences override correctly', () => {
      const config: RuntimeParams = { stopSequences: ['END'] };
      const session: RuntimeParams = { stopSequences: ['STOP', 'DONE'] };
      const result = mergeRuntimeParams(config, session, {});

      // stopSequences is a scalar field — session replaces config entirely
      expect(result.stopSequences).toEqual(['STOP', 'DONE']);
    });

    it('should handle all three layers with full parameters', () => {
      const config: RuntimeParams = {
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 2000,
        topP: 0.9,
        topK: 40,
        stopSequences: ['END'],
        systemPrompt: 'Default system prompt',
        providerSpecific: { seed: 42 },
      };
      const session: RuntimeParams = {
        model: 'gpt-4-turbo',
        temperature: 0.5,
        providerSpecific: { logprobs: true },
      };
      const prompt: RuntimeParams = {
        temperature: 1.2,
        maxTokens: 500,
        providerSpecific: { seed: 123 },
      };
      const result = mergeRuntimeParams(config, session, prompt);

      expect(result).toEqual({
        model: 'gpt-4-turbo',           // session
        temperature: 1.2,               // prompt
        maxTokens: 500,                 // prompt
        topP: 0.9,                      // config
        topK: 40,                       // config
        stopSequences: ['END'],         // config
        systemPrompt: 'Default system prompt', // config
        providerSpecific: {
          seed: 123,                    // prompt overrides config
          logprobs: true,               // session
        },
      });
    });
  });
});
