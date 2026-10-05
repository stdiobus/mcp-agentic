/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based and unit tests for `mergeRuntimeParams` — `detail` field.
 *
 * Tests cover:
 * - Property 1: `mergeRuntimeParams` `detail` priority
 *   For any combination of (configDefaults, sessionParams, promptParams) the
 *   merged `detail` equals the value from the highest-priority layer that has
 *   a defined value. When all three layers have `detail` undefined the key
 *   must be entirely absent from the merged result.
 *
 * Validates: Requirements 3.2, 3.3
 * Feature: multimodal-content-and-responses-api
 */

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { mergeRuntimeParams } from '../../../src/provider/AIProvider.js';
import type { RuntimeParams } from '../../../src/provider/AIProvider.js';

// ── Arbitraries ─────────────────────────────────────────────────

/** All valid `detail` literal values. */
const DETAIL_VALUES = ['low', 'high', 'original', 'auto'] as const;
type DetailValue = (typeof DETAIL_VALUES)[number];

/** Arbitrary: one of the four valid `detail` values. */
const arbDetail: fc.Arbitrary<DetailValue> = fc.constantFrom(...DETAIL_VALUES);

/** Arbitrary: an optional `detail` — one of the four values or `undefined`. */
const arbOptionalDetail: fc.Arbitrary<DetailValue | undefined> = fc.option(arbDetail, {
  nil: undefined,
  freq: 3, // ~75 % defined, ~25 % undefined — exercises the absent branch often enough
});

/**
 * Minimal `RuntimeParams` carrying only `detail` (other fields irrelevant for
 * this property). Using a minimal shape keeps the test focused and the
 * generated shrink-trees small.
 */
const arbParamsWithDetail: fc.Arbitrary<Pick<RuntimeParams, 'detail'>> = fc.record({
  detail: arbOptionalDetail,
});

// ── Property 1 ──────────────────────────────────────────────────

describe('mergeRuntimeParams — detail priority', () => {
  describe(
    'Feature: multimodal-content-and-responses-api, Property 1: mergeRuntimeParams detail priority',
    () => {
      // ── Property-based tests ───────────────────────────────────

      it(
        'property: merged detail equals the highest-priority defined value across all three layers',
        () => {
          fc.assert(
            fc.property(
              arbParamsWithDetail,
              arbParamsWithDetail,
              arbParamsWithDetail,
              (configDefaults, sessionParams, promptParams) => {
                const merged = mergeRuntimeParams(configDefaults, sessionParams, promptParams);

                const expected =
                  promptParams.detail ?? sessionParams.detail ?? configDefaults.detail;

                if (expected !== undefined) {
                  // detail must be present and equal to the expected value
                  return merged.detail === expected;
                } else {
                  // All three layers are undefined → key must be absent entirely
                  return !Object.prototype.hasOwnProperty.call(merged, 'detail');
                }
              },
            ),
            { numRuns: 500 },
          );
        },
      );

      it(
        'property: when detail is undefined at all three layers it is absent (not set to undefined)',
        () => {
          fc.assert(
            fc.property(
              // Build params that explicitly do NOT carry detail at all
              fc.record({ model: fc.option(fc.string({ minLength: 1 }), { nil: undefined }) }),
              fc.record({ temperature: fc.option(fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }), { nil: undefined }) }),
              fc.record({ maxTokens: fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined }) }),
              (configDefaults, sessionParams, promptParams) => {
                // None of these carries `detail` — it is structurally absent
                const merged = mergeRuntimeParams(configDefaults, sessionParams, promptParams);

                return !Object.prototype.hasOwnProperty.call(merged, 'detail');
              },
            ),
            { numRuns: 200 },
          );
        },
      );

      it(
        'property: prompt-level detail overrides both session and config',
        () => {
          fc.assert(
            fc.property(
              arbDetail,          // prompt detail — always defined
              arbOptionalDetail,  // session detail — may or may not be defined
              arbOptionalDetail,  // config detail — may or may not be defined
              (promptDetail, sessionDetail, configDetail) => {
                const merged = mergeRuntimeParams(
                  { detail: configDetail },
                  { detail: sessionDetail },
                  { detail: promptDetail },
                );

                return merged.detail === promptDetail;
              },
            ),
            { numRuns: 200 },
          );
        },
      );

      it(
        'property: when prompt detail is absent, session detail overrides config',
        () => {
          fc.assert(
            fc.property(
              arbDetail,          // session detail — always defined
              arbOptionalDetail,  // config detail — may or may not be defined
              (sessionDetail, configDetail) => {
                const merged = mergeRuntimeParams(
                  { detail: configDetail },
                  { detail: sessionDetail },
                  {},            // prompt carries no detail
                );

                return merged.detail === sessionDetail;
              },
            ),
            { numRuns: 200 },
          );
        },
      );

      it(
        'property: when prompt and session detail are both absent, config detail is used',
        () => {
          fc.assert(
            fc.property(
              arbDetail, // config detail — always defined
              (configDetail) => {
                const merged = mergeRuntimeParams(
                  { detail: configDetail },
                  {},  // session — no detail
                  {},  // prompt  — no detail
                );

                return merged.detail === configDetail;
              },
            ),
            { numRuns: 100 },
          );
        },
      );

      // ── Example-based tests ────────────────────────────────────

      describe('unit: example-based priority levels', () => {
        it('prompt detail takes precedence over session and config', () => {
          const result = mergeRuntimeParams(
            { detail: 'low' },
            { detail: 'high' },
            { detail: 'original' },
          );
          expect(result.detail).toBe('original');
        });

        it('session detail takes precedence over config when prompt omits detail', () => {
          const result = mergeRuntimeParams(
            { detail: 'low' },
            { detail: 'high' },
            {},
          );
          expect(result.detail).toBe('high');
        });

        it('config detail is used when both session and prompt omit detail', () => {
          const result = mergeRuntimeParams(
            { detail: 'auto' },
            {},
            {},
          );
          expect(result.detail).toBe('auto');
        });

        it('detail is absent when all three layers are undefined', () => {
          const result = mergeRuntimeParams({}, {}, {});
          expect(Object.prototype.hasOwnProperty.call(result, 'detail')).toBe(false);
          expect(result.detail).toBeUndefined();
        });

        it('detail is absent when called with no arguments', () => {
          const result = mergeRuntimeParams();
          expect(Object.prototype.hasOwnProperty.call(result, 'detail')).toBe(false);
        });

        it('all four valid detail values are accepted at prompt level', () => {
          const values: DetailValue[] = ['low', 'high', 'original', 'auto'];
          for (const v of values) {
            const result = mergeRuntimeParams({}, {}, { detail: v });
            expect(result.detail).toBe(v);
          }
        });

        it('all four valid detail values are accepted at session level', () => {
          const values: DetailValue[] = ['low', 'high', 'original', 'auto'];
          for (const v of values) {
            const result = mergeRuntimeParams({}, { detail: v }, {});
            expect(result.detail).toBe(v);
          }
        });

        it('all four valid detail values are accepted at config level', () => {
          const values: DetailValue[] = ['low', 'high', 'original', 'auto'];
          for (const v of values) {
            const result = mergeRuntimeParams({ detail: v }, {}, {});
            expect(result.detail).toBe(v);
          }
        });

        it('detail coexists correctly with other scalar fields', () => {
          const result = mergeRuntimeParams(
            { model: 'gpt-4', temperature: 0.7, detail: 'low' },
            { model: 'gpt-4o', detail: 'high' },
            { maxTokens: 500 },
          );
          expect(result.detail).toBe('high');   // session wins (prompt omits)
          expect(result.model).toBe('gpt-4o');  // session wins
          expect(result.temperature).toBe(0.7); // config fallback
          expect(result.maxTokens).toBe(500);   // prompt wins
        });

        it('prompt detail of low overrides session high and config auto', () => {
          const result = mergeRuntimeParams(
            { detail: 'auto' },
            { detail: 'high' },
            { detail: 'low' },
          );
          expect(result.detail).toBe('low');
        });

        it('session detail of original overrides config low when prompt is absent', () => {
          const result = mergeRuntimeParams(
            { detail: 'low' },
            { detail: 'original' },
            {},
          );
          expect(result.detail).toBe('original');
        });
      });
    },
  );
});
