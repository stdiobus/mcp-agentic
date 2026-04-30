/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * openAI — Declarative factory for the OpenAI provider.
 *
 * Built on top of {@link defineProvider}, this factory creates an
 * {@link OpenAIProvider} instance with Zod-validated flat options
 * and discoverable static metadata.
 *
 * The `openai` npm package is a peer dependency. If it is not installed,
 * the factory throws a {@link BridgeError} CONFIG with an installation
 * instruction at call time.
 *
 * @module provider/factories/openai
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import { defineProvider } from '../defineProvider.js';
import { BridgeError } from '../../errors/BridgeError.js';
import { OpenAIProvider } from '../providers/OpenAIProvider.js';
import type { RuntimeParams } from '../AIProvider.js';

const esmRequire = createRequire(import.meta.url);

// ── Zod schema for OpenAI options ───────────────────────────────

const OpenAIOptionsSchema = z.object({
  /** OpenAI API key. */
  apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
  /** List of supported model identifiers. */
  models: z.array(z.string()).nonempty('models must contain at least one model'),
  /** Default RuntimeParams applied when no override is specified. */
  defaults: z.custom<RuntimeParams>().optional(),
});

/** Typed options for the {@link openAI} factory. */
export type OpenAIOptions = z.infer<typeof OpenAIOptionsSchema>;

// ── Factory ─────────────────────────────────────────────────────

/**
 * Declarative factory for creating an OpenAI provider.
 *
 * @example
 * ```ts
 * import { openAI } from '@stdiobus/mcp-agentic';
 *
 * const provider = openAI({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   models: ['gpt-4o', 'gpt-4o-mini'],
 * });
 * ```
 */
export const openAI = defineProvider({
  id: 'openai',
  kind: 'llm',
  displayName: 'OpenAI',
  description: 'OpenAI GPT models via official openai npm SDK',
  schema: OpenAIOptionsSchema,
  capabilities: {
    streaming: true,
    tools: true,
    vision: true,
    jsonMode: true,
  },
  create: (options) => {
    // Synchronous SDK loading via createRequire (ESM-compatible)
    let OpenAISDK: any;
    try {
      const mod = esmRequire('openai');
      OpenAISDK = mod.default ?? mod;
    } catch {
      throw BridgeError.config(
        'OpenAI SDK ("openai" package) is not installed. Install it with: npm install openai',
        { providerId: 'openai' },
      );
    }

    // Map flat options → existing ProviderConfig and construct provider
    return new OpenAIProvider(
      {
        credentials: { apiKey: options.apiKey },
        models: options.models,
        ...(options.defaults !== undefined ? { defaults: options.defaults } : {}),
      },
      OpenAISDK,
    );
  },
});
