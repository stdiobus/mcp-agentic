/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * openAIResponses — Declarative factory for the OpenAI Responses API provider.
 *
 * Built on top of {@link defineProvider}, this factory creates an
 * {@link OpenAIResponsesProvider} instance with Zod-validated flat options
 * and discoverable static metadata.
 *
 * Targets the `/v1/responses` endpoint exclusively — never calls
 * `/v1/chat/completions`. Supports native `input_file`, `input_image`,
 * and `input_text` input items, as well as server-side file management
 * via the `FilesAPI` interface.
 *
 * The `openai` npm package is a peer dependency. If it is not installed,
 * the factory throws a {@link BridgeError} CONFIG with an installation
 * instruction at call time.
 *
 * @module provider/factories/openai-responses
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import { defineProvider } from '../defineProvider.js';
import { BridgeError } from '../../errors/BridgeError.js';
import { OpenAIResponsesProvider } from '../providers/OpenAIResponsesProvider.js';
import type { RuntimeParams } from '../AIProvider.js';

const esmRequire = createRequire(import.meta.url);

// ── Zod schema for OpenAI Responses options ─────────────────────

const OpenAIResponsesOptionsSchema = z.object({
  /** OpenAI API key. */
  apiKey: z.string().min(1, 'apiKey must be a non-empty string'),
  /** List of supported model identifiers. */
  models: z.array(z.string()).nonempty('models must contain at least one model'),
  /** Default RuntimeParams applied when no override is specified. */
  defaults: z.custom<RuntimeParams>().optional(),
});

/** Typed options for the {@link openAIResponses} factory. */
export type OpenAIResponsesOptions = z.infer<typeof OpenAIResponsesOptionsSchema>;

// ── Factory ─────────────────────────────────────────────────────

/**
 * Declarative factory for creating an OpenAI Responses API provider.
 *
 * Calls the `/v1/responses` endpoint exclusively. Use when you need
 * native `input_file` / `input_image` support or want to reference
 * files by URL without pre-uploading them.
 *
 * @example
 * ```ts
 * import { openAIResponses } from '@stdiobus/mcp-agentic';
 *
 * const provider = openAIResponses({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   models: ['gpt-4o', 'gpt-4o-mini'],
 * });
 * ```
 */
export const openAIResponses = defineProvider({
  id: 'openai-responses',
  kind: 'llm',
  displayName: 'OpenAI Responses',
  description: 'OpenAI GPT models via /v1/responses endpoint with native file and image support',
  schema: OpenAIResponsesOptionsSchema,
  capabilities: {
    streaming: false,
    tools: false,
    vision: true,
    jsonMode: true,
    files: true,
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
        { providerId: 'openai-responses' },
      );
    }

    // Map flat options → existing ProviderConfig and construct provider
    return new OpenAIResponsesProvider(
      {
        credentials: { apiKey: options.apiKey },
        models: options.models,
        ...(options.defaults !== undefined ? { defaults: options.defaults } : {}),
      },
      OpenAISDK,
    );
  },
});
