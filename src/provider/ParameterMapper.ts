/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ParameterMapper — Generic, declarative parameter mapping for AI providers.
 *
 * Each provider defines a set of {@link ModelProfile} objects that describe
 * how to map {@link RuntimeParams} fields to SDK-specific parameter names.
 * The {@link mapParameters} function resolves the correct profile for a given
 * model and produces an SDK-ready parameter object.
 *
 * Design principles:
 * - **Declarative**: profiles are plain data objects, not code.
 * - **Hierarchical**: default → prefix match → exact match (more specific wins).
 * - **Minimal**: no plugin systems, DI, or runtime registration.
 *
 * @module provider/ParameterMapper
 */

import type { RuntimeParams } from './AIProvider.js';

// ── ModelProfile interface ──────────────────────────────────────

/**
 * Declarative mapping profile for a model or model family.
 *
 * Profiles describe how to rename RuntimeParams fields to SDK parameter names.
 * Multiple profiles can be defined per provider; the most specific match wins.
 *
 * Resolution order (ascending priority):
 * 1. Default profile (`match: 'default'`)
 * 2. Prefix match (`match: 'prefix'`, e.g., `'gpt-4o'` matches `'gpt-4o-mini'`)
 * 3. Exact match (`match: 'exact'`, e.g., `'gpt-4o'` matches only `'gpt-4o'`)
 *
 * Prefix matching uses word-boundary semantics: a model matches a prefix if
 * the model name equals the prefix exactly, or starts with the prefix followed
 * by a non-alphanumeric character. This prevents `'gpt-4'` from matching `'gpt-4o'`.
 */
export interface ModelProfile {
  /**
   * Match strategy for this profile.
   * - `'default'`: applies to all models (lowest priority).
   * - `'prefix'`: matches models starting with {@link pattern} (medium priority).
   * - `'exact'`: matches only the exact model name in {@link pattern} (highest priority).
   */
  match: 'default' | 'prefix' | 'exact';

  /**
   * The model name or prefix to match against.
   * Required for `'prefix'` and `'exact'` match types. Ignored for `'default'`.
   */
  pattern?: string;

  /**
   * Rename map: RuntimeParams field name → SDK parameter name.
   *
   * Only the five mappable fields are supported:
   * `'temperature'`, `'maxTokens'`, `'topP'`, `'topK'`, `'stopSequences'`.
   *
   * Example: `{ maxTokens: 'max_completion_tokens', topP: 'top_p' }`
   */
  renames: Partial<Record<MappableParam, string>>;

  /**
   * Parameters to exclude from the output.
   * Listed RuntimeParams fields will be omitted even if present in the input.
   */
  exclude?: MappableParam[];

  /**
   * Default values for SDK parameters.
   * Applied only when the corresponding RuntimeParams field is `undefined`.
   * Keys are the SDK parameter names (after renaming).
   */
  defaults?: Record<string, unknown>;
}

// ── Mappable parameter keys ─────────────────────────────────────

/** RuntimeParams fields that ParameterMapper handles. */
export type MappableParam = 'temperature' | 'maxTokens' | 'topP' | 'topK' | 'stopSequences';

/** All mappable parameter keys. */
const MAPPABLE_PARAMS: readonly MappableParam[] = [
  'temperature',
  'maxTokens',
  'topP',
  'topK',
  'stopSequences',
];

// ── Profile resolution ──────────────────────────────────────────

/** Match priority: default < prefix < exact. */
const MATCH_PRIORITY: Record<ModelProfile['match'], number> = {
  default: 0,
  prefix: 1,
  exact: 2,
};

/**
 * Check whether a model name matches a prefix with word-boundary semantics.
 *
 * A model matches a prefix if:
 * - The model name equals the prefix exactly (case-insensitive), OR
 * - The model name starts with the prefix and the next character is
 *   non-alphanumeric (e.g., dash, dot, colon).
 *
 * This prevents `'gpt-4'` from matching `'gpt-4o'` (where `'o'` is alphanumeric).
 */
function matchesPrefix(model: string, prefix: string): boolean {
  const lower = model.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();

  if (lower === lowerPrefix) {
    return true;
  }

  if (lower.startsWith(lowerPrefix) && lower.length > lowerPrefix.length) {
    const nextChar = lower[lowerPrefix.length]!;
    return !/[a-z0-9]/i.test(nextChar);
  }

  return false;
}

/**
 * Resolve the applicable profiles for a model, sorted by priority (ascending).
 *
 * Returns all matching profiles. When multiple prefix profiles match,
 * the longest (most specific) prefix wins. Among profiles of the same
 * match type, later entries in the input array take precedence.
 */
function resolveProfiles(profiles: readonly ModelProfile[], model: string): ModelProfile[] {
  const matched: Array<{ profile: ModelProfile; priority: number; specificity: number; index: number }> = [];

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i]!;

    switch (profile.match) {
      case 'default':
        matched.push({ profile, priority: MATCH_PRIORITY.default, specificity: 0, index: i });
        break;

      case 'prefix':
        if (profile.pattern && matchesPrefix(model, profile.pattern)) {
          matched.push({
            profile,
            priority: MATCH_PRIORITY.prefix,
            specificity: profile.pattern.length,
            index: i,
          });
        }
        break;

      case 'exact':
        if (profile.pattern && model.toLowerCase() === profile.pattern.toLowerCase()) {
          matched.push({ profile, priority: MATCH_PRIORITY.exact, specificity: 0, index: i });
        }
        break;
    }
  }

  // Sort: lower priority first, then by specificity (longer prefix wins), then by index
  matched.sort((a, b) =>
    a.priority - b.priority ||
    a.specificity - b.specificity ||
    a.index - b.index,
  );

  return matched.map((m) => m.profile);
}

// ── mapParameters ───────────────────────────────────────────────

/**
 * Map RuntimeParams to SDK-ready parameters using declarative profiles.
 *
 * Resolution:
 * 1. Find all matching profiles for the model.
 * 2. Merge profiles in priority order (default → prefix → exact); more specific wins.
 * 3. For each mappable RuntimeParams field:
 *    - If excluded by the merged profile, skip it.
 *    - If the value is defined, rename the key per the merged renames map and include it.
 *    - If the value is undefined, check merged defaults for the renamed key.
 * 4. Return the resulting SDK parameter object.
 *
 * **Not handled by ParameterMapper:**
 * - `model` and `systemPrompt` — providers handle these directly.
 * - `providerSpecific` — providers spread it over the result after calling mapParameters.
 *
 * @param profiles - Array of ModelProfile objects for the provider.
 * @param model - The model identifier string.
 * @param params - RuntimeParams from the request.
 * @returns SDK-ready parameter object with renamed keys.
 */
export function mapParameters(
  profiles: readonly ModelProfile[],
  model: string,
  params: RuntimeParams,
): Record<string, unknown> {
  const resolved = resolveProfiles(profiles, model);

  // Merge profiles: later (higher priority) overrides earlier
  const mergedRenames: Record<string, string> = {};
  const mergedExclude = new Set<string>();
  const mergedDefaults: Record<string, unknown> = {};

  for (const profile of resolved) {
    // Merge renames
    for (const [key, value] of Object.entries(profile.renames)) {
      mergedRenames[key] = value;
    }

    // Merge excludes
    if (profile.exclude) {
      for (const key of profile.exclude) {
        mergedExclude.add(key);
      }
    }

    // Merge defaults
    if (profile.defaults) {
      for (const [key, value] of Object.entries(profile.defaults)) {
        mergedDefaults[key] = value;
      }
    }
  }

  // Build output
  const result: Record<string, unknown> = {};

  for (const param of MAPPABLE_PARAMS) {
    if (mergedExclude.has(param)) {
      continue;
    }

    const sdkName = mergedRenames[param] ?? param;
    const value = params[param];

    if (value !== undefined) {
      result[sdkName] = value;
    } else if (sdkName in mergedDefaults) {
      result[sdkName] = mergedDefaults[sdkName];
    }
  }

  return result;
}
