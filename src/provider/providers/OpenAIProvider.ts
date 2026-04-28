/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAIProvider — AI provider adapter using the official `openai` npm package.
 *
 * The `openai` SDK is an optional peer dependency. Users install only the
 * SDKs they need. The provider uses a lazy dynamic import so that the
 * module can be loaded without the SDK present (it throws at first use).
 *
 * @module provider/providers/OpenAIProvider
 */

import type {
  AIProvider,
  AIProviderResult,
  ChatMessage,
  ProviderConfig,
  RuntimeParams,
} from '../AIProvider.js';
import { BridgeError } from '../../errors/BridgeError.js';

// ── Stop reason mapping ─────────────────────────────────────────

const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'content_filter',
};

// ── Types for the OpenAI SDK (minimal surface used) ─────────────

interface OpenAIClient {
  chat: {
    completions: {
      create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<OpenAIChatCompletion>;
    };
  };
}

interface OpenAIChatCompletion {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

// ── OpenAIProvider ──────────────────────────────────────────────

/**
 * OpenAI provider using the official `openai` npm SDK.
 *
 * Requires `openai` package to be installed as a peer dependency.
 * Credentials are passed via {@link ProviderConfig.credentials} — the
 * provider never accesses `process.env` directly after construction.
 */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  readonly models: readonly string[];

  private readonly client: OpenAIClient;
  private readonly defaults: RuntimeParams;

  /**
   * @param config - Provider configuration with credentials and model list.
   * @param openaiSDK - Optional injected SDK constructor (for testing). If not
   *   provided, the provider attempts to import the `openai` package.
   * @throws {BridgeError} CONFIG if `credentials.apiKey` is missing or empty.
   * @throws {BridgeError} CONFIG if the `openai` package is not installed.
   */
  constructor(config: ProviderConfig, openaiSDK?: new (opts: { apiKey: string }) => OpenAIClient) {
    const apiKey = config.credentials['apiKey'];
    if (!apiKey) {
      throw BridgeError.config(
        'OpenAI provider requires "apiKey" credential',
        { providerId: 'openai' },
      );
    }

    this.models = Object.freeze([...config.models]);
    this.defaults = config.defaults ?? {};

    if (openaiSDK) {
      this.client = new openaiSDK({ apiKey });
    } else {
      // Lazy resolution — will throw CONFIG error if SDK not installed.
      // In production, the peer dependency is resolved by Node.js module system.
      // In tests, the SDK is injected via the second parameter.
      throw BridgeError.config(
        'OpenAI SDK ("openai" package) must be injected via constructor or use OpenAIProvider.create()',
        { providerId: 'openai' },
      );
    }
  }

  /**
   * Factory method that dynamically imports the OpenAI SDK.
   *
   * @param config - Provider configuration.
   * @returns Promise resolving to a configured OpenAIProvider instance.
   * @throws {BridgeError} CONFIG if credentials are missing or SDK is not installed.
   */
  static async create(config: ProviderConfig): Promise<OpenAIProvider> {
    try {
      // @ts-expect-error — openai is an optional peer dependency; may not be installed
      const openaiModule = await import('openai');
      const OpenAI = openaiModule.default ?? openaiModule;
      return new OpenAIProvider(config, OpenAI as any);
    } catch (err: unknown) {
      if (err instanceof BridgeError) {
        throw err;
      }
      throw BridgeError.config(
        'OpenAI SDK ("openai" package) is not installed. Install it with: npm install openai',
        { providerId: 'openai' },
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Send a completion request to the OpenAI API.
   *
   * @param messages - Conversation history in standard chat format.
   * @param params - Runtime parameters for this request.
   * @param signal - Optional AbortSignal for cooperative cancellation.
   * @returns Normalized provider result.
   * @throws {BridgeError} UPSTREAM if no model is specified.
   * @throws {BridgeError} With appropriate category on SDK failure.
   */
  async complete(
    messages: ChatMessage[],
    params: RuntimeParams,
    signal?: AbortSignal,
  ): Promise<AIProviderResult> {
    const model = params.model ?? this.defaults.model;
    if (!model) {
      throw BridgeError.upstream(
        'No model specified and no default model configured',
        { providerId: this.id },
      );
    }

    // Convert ChatMessage[] to OpenAI message format
    const openaiMessages: Array<{ role: string; content: string }> = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Prepend systemPrompt as a system message if provided and not already present
    if (params.systemPrompt) {
      const hasSystemMessage = openaiMessages.some((m) => m.role === 'system');
      if (!hasSystemMessage) {
        openaiMessages.unshift({ role: 'system', content: params.systemPrompt });
      }
    }

    // Build request body
    const body: Record<string, unknown> = {
      model,
      messages: openaiMessages,
    };

    if (params.temperature !== undefined) {
      body['temperature'] = params.temperature;
    }
    if (params.maxTokens !== undefined) {
      body['max_tokens'] = params.maxTokens;
    }
    if (params.topP !== undefined) {
      body['top_p'] = params.topP;
    }
    if (params.stopSequences !== undefined) {
      body['stop'] = params.stopSequences;
    }

    // Spread providerSpecific — unsupported keys are passed through to the SDK
    if (params.providerSpecific) {
      for (const [key, value] of Object.entries(params.providerSpecific)) {
        body[key] = value;
      }
    }

    try {
      const options: { signal?: AbortSignal } = {};
      if (signal) {
        options.signal = signal;
      }
      const response = await this.client.chat.completions.create(body, options);

      // Normalize response
      const choice = response.choices?.[0];
      const text = choice?.message?.content ?? '';
      const nativeStopReason = choice?.finish_reason ?? 'unknown';
      const stopReason = STOP_REASON_MAP[nativeStopReason] ?? nativeStopReason;

      // Normalize usage
      const result: AIProviderResult = { text, stopReason };
      if (response.usage) {
        result.usage = {
          inputTokens: response.usage.prompt_tokens ?? 0,
          outputTokens: response.usage.completion_tokens ?? 0,
        };
      }

      return result;
    } catch (err: unknown) {
      throw this.mapError(err);
    }
  }

  // ── Error mapping ───────────────────────────────────────────────

  /**
   * Map OpenAI SDK errors to typed BridgeError categories.
   *
   * Classification uses constructor name matching, which works with both
   * the real SDK and mocked error classes in tests.
   */
  private mapError(err: unknown): BridgeError {
    const details = { providerId: this.id };

    // Already a BridgeError — pass through
    if (err instanceof BridgeError) {
      return err;
    }

    const error = err as Record<string, unknown>;
    const message = (error?.['message'] as string) ?? String(err);
    const cause = err instanceof Error ? err : new Error(message);
    const errorName = (err as any)?.constructor?.name as string | undefined;

    switch (errorName) {
      case 'AuthenticationError':
        return BridgeError.auth(message, details, cause);

      case 'RateLimitError':
        return new BridgeError('UPSTREAM', message, { ...details, retryable: true }, cause);

      case 'APIConnectionError':
        return BridgeError.transport(message, { ...details, retryable: true }, cause);

      case 'APITimeoutError':
        return BridgeError.timeout(message, { ...details, retryable: true }, cause);

      case 'BadRequestError':
        return new BridgeError('UPSTREAM', message, { ...details, retryable: false }, cause);

      case 'InternalServerError':
        return new BridgeError('UPSTREAM', message, { ...details, retryable: true }, cause);

      default:
        return new BridgeError('UPSTREAM', message, { ...details, retryable: false }, cause);
    }
  }
}
