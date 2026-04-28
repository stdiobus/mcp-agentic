/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AnthropicProvider — AI provider adapter using the official `@anthropic-ai/sdk` package.
 *
 * The `@anthropic-ai/sdk` SDK is an optional peer dependency. Users install
 * only the SDKs they need. The provider uses a lazy dynamic import so that the
 * module can be loaded without the SDK present (it throws at first use).
 *
 * @module provider/providers/AnthropicProvider
 */

import type {
  AIProvider,
  AIProviderResult,
  ChatMessage,
  ProviderConfig,
  RuntimeParams,
} from '../AIProvider.js';
import { BridgeError } from '../../errors/BridgeError.js';
import type { ModelProfile } from '../ParameterMapper.js';
import { mapParameters } from '../ParameterMapper.js';

// ── Stop reason mapping ─────────────────────────────────────────

const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
};

// ── Anthropic model profiles ────────────────────────────────────

/**
 * Declarative parameter mapping profiles for Anthropic models.
 *
 * All current Anthropic models use the same parameter names.
 * The default profile handles the full mapping.
 */
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

// ── Types for the Anthropic SDK (minimal surface used) ──────────

/** A single message in Anthropic format. */
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A content block in Anthropic response. */
interface AnthropicContentBlock {
  type: string;
  text?: string;
}

/** Usage data from Anthropic response. */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/** Anthropic messages.create() response shape. */
interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

/** Anthropic client interface (minimal surface). */
interface AnthropicClient {
  messages: {
    create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AnthropicMessageResponse>;
  };
}

// ── AnthropicProvider ───────────────────────────────────────────

/**
 * Anthropic provider using the official `@anthropic-ai/sdk` npm SDK.
 *
 * Requires `@anthropic-ai/sdk` package to be installed as a peer dependency.
 * Credentials are passed via {@link ProviderConfig.credentials} — the
 * provider never accesses `process.env` directly after construction.
 */
export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic';
  readonly models: readonly string[];

  private readonly client: AnthropicClient;
  private readonly defaults: RuntimeParams;

  /**
   * @param config - Provider configuration with credentials and model list.
   * @param anthropicSDK - Optional injected SDK constructor (for testing). If not
   *   provided, the provider requires using the static `create()` factory.
   * @throws {BridgeError} CONFIG if `credentials.apiKey` is missing or empty.
   * @throws {BridgeError} CONFIG if the SDK is not provided and create() is not used.
   */
  constructor(config: ProviderConfig, anthropicSDK?: new (opts: { apiKey: string }) => AnthropicClient) {
    const apiKey = config.credentials['apiKey'];
    if (!apiKey) {
      throw BridgeError.config(
        'Anthropic provider requires "apiKey" credential',
        { providerId: 'anthropic' },
      );
    }

    this.models = Object.freeze([...config.models]);
    this.defaults = config.defaults ?? {};

    if (anthropicSDK) {
      this.client = new anthropicSDK({ apiKey });
    } else {
      throw BridgeError.config(
        'Anthropic SDK ("@anthropic-ai/sdk" package) must be injected via constructor or use AnthropicProvider.create()',
        { providerId: 'anthropic' },
      );
    }
  }

  /**
   * Factory method that dynamically imports the Anthropic SDK.
   *
   * @param config - Provider configuration.
   * @returns Promise resolving to a configured AnthropicProvider instance.
   * @throws {BridgeError} CONFIG if credentials are missing or SDK is not installed.
   */
  static async create(config: ProviderConfig): Promise<AnthropicProvider> {
    try {
      // @ts-ignore — @anthropic-ai/sdk is an optional peer dependency; may not be installed
      const anthropicModule = await import('@anthropic-ai/sdk');
      const Anthropic = anthropicModule.default ?? anthropicModule;
      return new AnthropicProvider(config, Anthropic as any);
    } catch (err: unknown) {
      if (err instanceof BridgeError) {
        throw err;
      }
      throw BridgeError.config(
        'Anthropic SDK ("@anthropic-ai/sdk" package) is not installed. Install it with: npm install @anthropic-ai/sdk',
        { providerId: 'anthropic' },
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Send a completion request to the Anthropic API.
   *
   * The Anthropic API requires `system` as a top-level parameter, separate
   * from the messages array. This method extracts system messages and the
   * `systemPrompt` param into the top-level `system` field.
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

    // Extract system prompt and non-system messages
    const { anthropicMessages, systemPrompt } = this.extractSystemPrompt(messages, params.systemPrompt);

    // Build request body
    const body: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      ...mapParameters(ANTHROPIC_PROFILES, model, params),
    };

    if (systemPrompt) {
      body['system'] = systemPrompt;
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
      const response = await this.client.messages.create(body, options);

      // Extract text from content blocks (type: 'text')
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      // Normalize stop reason
      const nativeStopReason = response.stop_reason ?? 'unknown';
      const stopReason = STOP_REASON_MAP[nativeStopReason] ?? nativeStopReason;

      // Normalize usage
      const result: AIProviderResult = { text, stopReason };
      if (response.usage) {
        result.usage = {
          inputTokens: response.usage.input_tokens ?? 0,
          outputTokens: response.usage.output_tokens ?? 0,
        };
      }

      return result;
    } catch (err: unknown) {
      throw this.mapError(err);
    }
  }

  // ── System prompt extraction ────────────────────────────────────

  /**
   * Extract system messages from the message array and combine with
   * the systemPrompt parameter into a single top-level system string.
   *
   * Anthropic requires system prompt as a top-level `system` parameter,
   * not as a message in the messages array.
   */
  private extractSystemPrompt(
    messages: ChatMessage[],
    systemPromptParam?: string,
  ): {
    anthropicMessages: AnthropicMessage[];
    systemPrompt: string | null;
  } {
    const systemParts: string[] = [];
    const anthropicMessages: AnthropicMessage[] = [];

    // Collect system messages and separate non-system messages
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content);
      } else {
        anthropicMessages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    // Add systemPrompt from params if no system messages were found in the array
    if (systemPromptParam && systemParts.length === 0) {
      systemParts.push(systemPromptParam);
    }

    const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : null;

    return { anthropicMessages, systemPrompt };
  }

  // ── Error mapping ───────────────────────────────────────────────

  /**
   * Map Anthropic SDK errors to typed BridgeError categories.
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

      case 'APIConnectionTimeoutError':
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
