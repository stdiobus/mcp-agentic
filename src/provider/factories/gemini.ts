/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * gemini — Declarative factory for the Google Gemini provider.
 *
 * Built on top of {@link defineProvider}, this factory creates a
 * {@link GoogleGeminiProvider} instance with Zod-validated flat options
 * and discoverable static metadata.
 *
 * The `@google/generative-ai` npm package is a peer dependency. If it is not
 * installed, the factory throws a {@link BridgeError} CONFIG with an
 * installation instruction at call time.
 *
 * @module provider/factories/gemini
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import { defineProvider } from '../defineProvider.js';
import { BridgeError } from '../../errors/BridgeError.js';
import type { RuntimeParams } from '../AIProvider.js';

const esmRequire = createRequire(import.meta.url);

// ── Zod schema for Gemini options ───────────────────────────────

const GeminiOptionsSchema = z.object({
  /** Google Gemini API key. */
  apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
  /** List of supported model identifiers. */
  models: z.array(z.string()).nonempty('models must contain at least one model'),
  /** Default RuntimeParams applied when no override is specified. */
  defaults: z.custom<RuntimeParams>().optional(),
});

/** Typed options for the {@link gemini} factory. */
export type GeminiOptions = z.infer<typeof GeminiOptionsSchema>;

// ── Factory ─────────────────────────────────────────────────────

/**
 * Declarative factory for creating a Google Gemini provider.
 *
 * @example
 * ```ts
 * import { gemini } from '@stdiobus/mcp-agentic';
 *
 * const provider = gemini({
 *   apiKey: process.env.GOOGLE_AI_API_KEY!,
 *   models: ['gemini-2.0-flash'],
 * });
 * ```
 */
export const gemini = defineProvider({
  id: 'google-gemini',
  kind: 'llm',
  displayName: 'Google Gemini',
  description: 'Google Gemini models via official @google/generative-ai SDK',
  schema: GeminiOptionsSchema,
  capabilities: {
    streaming: false,
    tools: false,
    vision: true,
    jsonMode: true,
  },
  create: (options) => {
    // Synchronous SDK loading via createRequire (ESM-compatible)
    let GoogleGenerativeAI: any;
    try {
      const mod = esmRequire('@google/generative-ai');
      GoogleGenerativeAI = mod.GoogleGenerativeAI ?? mod.default;
    } catch {
      throw BridgeError.config(
        'Google Gemini SDK ("@google/generative-ai" package) is not installed. Install it with: npm install @google/generative-ai',
        { providerId: 'google-gemini' },
      );
    }

    // Map flat options → existing ProviderConfig and construct provider
    const { GoogleGeminiProvider } = esmRequire('../providers/GoogleGeminiProvider.js');
    return new GoogleGeminiProvider(
      {
        credentials: { apiKey: options.apiKey },
        models: options.models,
        defaults: options.defaults,
      },
      GoogleGenerativeAI,
    );
  },
});
