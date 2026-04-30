/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * anthropic — Declarative factory for the Anthropic provider.
 *
 * Built on top of {@link defineProvider}, this factory creates an
 * {@link AnthropicProvider} instance with Zod-validated flat options
 * and discoverable static metadata.
 *
 * The `@anthropic-ai/sdk` npm package is a peer dependency. If it is not
 * installed, the factory throws a {@link BridgeError} CONFIG with an
 * installation instruction at call time.
 *
 * @module provider/factories/anthropic
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import { defineProvider } from '../defineProvider.js';
import { BridgeError } from '../../errors/BridgeError.js';
import { AnthropicProvider } from '../providers/AnthropicProvider.js';
import type { RuntimeParams } from '../AIProvider.js';

const esmRequire = createRequire(import.meta.url);

// ── Zod schema for Anthropic options ────────────────────────────

const AnthropicOptionsSchema = z.object({
  /** Anthropic API key. */
  apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
  /** List of supported model identifiers. */
  models: z.array(z.string()).nonempty('models must contain at least one model'),
  /** Default RuntimeParams applied when no override is specified. */
  defaults: z.custom<RuntimeParams>().optional(),
});

/** Typed options for the {@link anthropic} factory. */
export type AnthropicOptions = z.infer<typeof AnthropicOptionsSchema>;

// ── Factory ─────────────────────────────────────────────────────

/**
 * Declarative factory for creating an Anthropic provider.
 *
 * @example
 * ```ts
 * import { anthropic } from '@stdiobus/mcp-agentic';
 *
 * const provider = anthropic({
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 *   models: ['claude-sonnet-4-20250514'],
 * });
 * ```
 */
export const anthropic = defineProvider({
  id: 'anthropic',
  kind: 'llm',
  displayName: 'Anthropic',
  description: 'Anthropic Claude models via official @anthropic-ai/sdk',
  schema: AnthropicOptionsSchema,
  capabilities: {
    streaming: true,
    tools: true,
    vision: true,
    jsonMode: false,
  },
  create: (options) => {
    // Synchronous SDK loading via createRequire (ESM-compatible)
    let AnthropicSDK: any;
    try {
      const mod = esmRequire('@anthropic-ai/sdk');
      AnthropicSDK = mod.default ?? mod;
    } catch {
      throw BridgeError.config(
        'Anthropic SDK ("@anthropic-ai/sdk" package) is not installed. Install it with: npm install @anthropic-ai/sdk',
        { providerId: 'anthropic' },
      );
    }

    // Map flat options → existing ProviderConfig and construct provider
    return new AnthropicProvider(
      {
        credentials: { apiKey: options.apiKey },
        models: options.models,
        ...(options.defaults !== undefined ? { defaults: options.defaults } : {}),
      },
      AnthropicSDK,
    );
  },
});
