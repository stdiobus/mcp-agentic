/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * defineProvider — Standardized contract for defining AI providers.
 *
 * Creates a typed factory function with Zod-validated options and
 * discoverable static metadata. Both built-in providers (openAI,
 * anthropic, gemini) and custom providers use this contract.
 *
 * @module provider/defineProvider
 */

import { z } from 'zod';
import { BridgeError } from '../errors/BridgeError.js';
import type { AIProvider, ProviderKind, ProviderCapabilities } from './AIProvider.js';

// ── Types ───────────────────────────────────────────────────────

/** Configuration for {@link defineProvider}. */
export interface DefineProviderConfig<TSchema extends z.ZodTypeAny> {
  /** Unique provider identifier (e.g., `'openai'`, `'my-custom-llm'`). */
  id: string;
  /** Zod schema for validating factory options at call time. */
  schema: TSchema;
  /** Function that creates an {@link AIProvider} from validated options. */
  create: (options: z.infer<TSchema>) => AIProvider;
  /** Type of provider. Defaults to `'llm'`. */
  kind?: ProviderKind;
  /** Human-readable display name. Defaults to `id`. */
  displayName?: string;
  /** Provider description. Defaults to `''`. */
  description?: string;
  /** Self-reported capabilities. Defaults to `{}`. */
  capabilities?: ProviderCapabilities;
}

/**
 * Type returned by {@link defineProvider}.
 *
 * A callable factory function `(options) => AIProvider` with static
 * readonly metadata properties for introspection and discovery.
 */
export type DefinedProvider<TSchema extends z.ZodTypeAny> = {
  /** Call the factory: validates options via Zod, calls create, returns AIProvider. */
  (options: z.infer<TSchema>): AIProvider;

  /** Unique provider identifier. */
  readonly id: string;
  /** Type of provider. */
  readonly kind: ProviderKind;
  /** Zod schema for options (for introspection and JSON Schema generation). */
  readonly schema: TSchema;
  /** Self-reported capabilities. */
  readonly capabilities: ProviderCapabilities;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Provider description. */
  readonly description: string;
};

// ── Implementation ──────────────────────────────────────────────

/**
 * Create a typed provider factory with Zod validation and discoverable metadata.
 *
 * Built-in providers (openAI, anthropic, gemini) are also implemented via
 * `defineProvider`, ensuring a single consistent contract across the ecosystem.
 *
 * @param config - Provider definition configuration.
 * @returns Callable factory with attached static metadata.
 *
 * @example
 * ```ts
 * const myProvider = defineProvider({
 *   id: 'my-llm',
 *   schema: z.object({ apiKey: z.string().min(1), models: z.array(z.string()).nonempty() }),
 *   create: (opts) => new MyLLMProvider(opts),
 * });
 *
 * const provider = myProvider({ apiKey: 'sk-...', models: ['my-model'] });
 * ```
 */
export function defineProvider<TSchema extends z.ZodTypeAny>(
  config: DefineProviderConfig<TSchema>,
): DefinedProvider<TSchema> {
  const {
    id,
    schema,
    create,
    kind = 'llm',
    displayName = id,
    description = '',
    capabilities = {},
  } = config;

  const factory = (rawOptions: z.infer<TSchema>): AIProvider => {
    // 1. Validate options via Zod
    let options: z.infer<TSchema>;
    try {
      options = schema.parse(rawOptions);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        const details = err.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw BridgeError.config(
          `Invalid options for provider "${id}": ${details}`,
          { providerId: id },
        );
      }
      throw err;
    }

    // 2. Call create with validated options
    const provider = create(options);

    // 3. Validate create() result — must satisfy AIProvider contract
    if (!provider || typeof provider.complete !== 'function') {
      throw BridgeError.config(
        `Provider "${id}" create() must return an object with complete() method`,
        { providerId: id },
      );
    }
    if (!provider.id) {
      throw BridgeError.config(
        `Provider "${id}" create() must return an object with id property`,
        { providerId: id },
      );
    }
    if (!provider.models || !Array.isArray(provider.models)) {
      throw BridgeError.config(
        `Provider "${id}" create() must return an object with models array`,
        { providerId: id },
      );
    }

    // 4. Attach kind, capabilities, displayName, and description via
    //    Object.defineProperties (only if the provider didn't set them already).
    //    displayName and description are read by ProviderRegistry.list()
    //    via duck-typing for enriched agents_discover responses.
    const providerAny = provider as unknown as Record<string, unknown>;
    const descriptors: PropertyDescriptorMap = {
      kind: {
        value: provider.kind ?? kind,
        writable: false,
        enumerable: true,
      },
      capabilities: {
        value: {
          streaming: typeof (provider as any).stream === 'function',
          tools: false,
          vision: false,
          jsonMode: false,
          ...capabilities,
          ...(provider.capabilities ?? {}),
        },
        writable: false,
        enumerable: true,
      },
    };
    if (providerAny['displayName'] === undefined && displayName) {
      descriptors['displayName'] = { value: displayName, writable: false, enumerable: true };
    }
    if (providerAny['description'] === undefined && description) {
      descriptors['description'] = { value: description, writable: false, enumerable: true };
    }
    return Object.defineProperties(provider, descriptors) as AIProvider;
  };

  // 5. Attach static metadata on the factory function
  Object.defineProperties(factory, {
    id: { value: id, writable: false, enumerable: true },
    kind: { value: kind, writable: false, enumerable: true },
    schema: { value: schema, writable: false, enumerable: true },
    capabilities: { value: capabilities, writable: false, enumerable: true },
    displayName: { value: displayName, writable: false, enumerable: true },
    description: { value: description, writable: false, enumerable: true },
  });

  return factory as DefinedProvider<TSchema>;
}
