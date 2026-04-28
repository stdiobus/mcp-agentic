/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GoogleGeminiProvider — AI provider adapter using the official `@google/generative-ai` package.
 *
 * The `@google/generative-ai` SDK is an optional peer dependency. Users install
 * only the SDKs they need. The provider uses a lazy dynamic import so that the
 * module can be loaded without the SDK present (it throws at first use).
 *
 * @module provider/providers/GoogleGeminiProvider
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
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'content_filter',
};

// ── Types for the Gemini SDK (minimal surface used) ─────────────

/** A single content part in Gemini format. */
interface GeminiPart {
  text: string;
}

/** A content entry in Gemini format (role + parts). */
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/** Generation configuration for Gemini requests. */
interface GeminiGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
}

/** Usage metadata from Gemini response. */
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

/** A single candidate in Gemini response. */
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

/** Gemini generateContent response shape. */
interface GeminiGenerateContentResponse {
  response: {
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
  };
}

/** Gemini generative model interface. */
interface GeminiGenerativeModel {
  generateContent(request: {
    contents: GeminiContent[];
    generationConfig?: GeminiGenerationConfig;
    systemInstruction?: { parts: GeminiPart[] };
  }): Promise<GeminiGenerateContentResponse>;
}

/** GoogleGenerativeAI client interface. */
interface GoogleGenerativeAIClient {
  getGenerativeModel(params: { model: string }): GeminiGenerativeModel;
}

// ── GoogleGeminiProvider ────────────────────────────────────────

/**
 * Google Gemini provider using the official `@google/generative-ai` npm SDK.
 *
 * Requires `@google/generative-ai` package to be installed as a peer dependency.
 * Credentials are passed via {@link ProviderConfig.credentials} — the
 * provider never accesses `process.env` directly after construction.
 */
export class GoogleGeminiProvider implements AIProvider {
  readonly id = 'google-gemini';
  readonly models: readonly string[];

  private readonly client: GoogleGenerativeAIClient;
  private readonly defaults: RuntimeParams;

  /**
   * @param config - Provider configuration with credentials and model list.
   * @param geminiSDK - Optional injected SDK constructor (for testing). If not
   *   provided, the provider requires using the static `create()` factory.
   * @throws {BridgeError} CONFIG if `credentials.apiKey` is missing or empty.
   * @throws {BridgeError} CONFIG if the SDK is not provided and create() is not used.
   */
  constructor(config: ProviderConfig, geminiSDK?: new (apiKey: string) => GoogleGenerativeAIClient) {
    const apiKey = config.credentials['apiKey'];
    if (!apiKey) {
      throw BridgeError.config(
        'Google Gemini provider requires "apiKey" credential',
        { providerId: 'google-gemini' },
      );
    }

    this.models = Object.freeze([...config.models]);
    this.defaults = config.defaults ?? {};

    if (geminiSDK) {
      this.client = new geminiSDK(apiKey);
    } else {
      throw BridgeError.config(
        'Google Gemini SDK ("@google/generative-ai" package) must be injected via constructor or use GoogleGeminiProvider.create()',
        { providerId: 'google-gemini' },
      );
    }
  }

  /**
   * Factory method that dynamically imports the Google Gemini SDK.
   *
   * @param config - Provider configuration.
   * @returns Promise resolving to a configured GoogleGeminiProvider instance.
   * @throws {BridgeError} CONFIG if credentials are missing or SDK is not installed.
   */
  static async create(config: ProviderConfig): Promise<GoogleGeminiProvider> {
    try {
      // @ts-ignore — @google/generative-ai is an optional peer dependency; may not be installed
      const geminiModule = await import('@google/generative-ai');
      const GoogleGenerativeAI = geminiModule.GoogleGenerativeAI ?? geminiModule.default;
      return new GoogleGeminiProvider(config, GoogleGenerativeAI as any);
    } catch (err: unknown) {
      if (err instanceof BridgeError) {
        throw err;
      }
      throw BridgeError.config(
        'Google Gemini SDK ("@google/generative-ai" package) is not installed. Install it with: npm install @google/generative-ai',
        { providerId: 'google-gemini' },
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Send a completion request to the Google Gemini API.
   *
   * @param messages - Conversation history in standard chat format.
   * @param params - Runtime parameters for this request.
   * @param _signal - Optional AbortSignal (not directly supported by Gemini SDK).
   * @returns Normalized provider result.
   * @throws {BridgeError} UPSTREAM if no model is specified.
   * @throws {BridgeError} With appropriate category on SDK failure.
   */
  async complete(
    messages: ChatMessage[],
    params: RuntimeParams,
    _signal?: AbortSignal,
  ): Promise<AIProviderResult> {
    const model = params.model ?? this.defaults.model;
    if (!model) {
      throw BridgeError.upstream(
        'No model specified and no default model configured',
        { providerId: this.id },
      );
    }

    // Convert ChatMessage[] to Gemini Content[] format
    const { contents, systemInstruction } = this.convertMessages(messages, params.systemPrompt);

    // Build generation config
    const generationConfig: GeminiGenerationConfig = {};
    if (params.temperature !== undefined) {
      generationConfig.temperature = params.temperature;
    }
    if (params.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = params.maxTokens;
    }
    if (params.topP !== undefined) {
      generationConfig.topP = params.topP;
    }
    if (params.topK !== undefined) {
      generationConfig.topK = params.topK;
    }
    if (params.stopSequences !== undefined) {
      generationConfig.stopSequences = params.stopSequences;
    }

    try {
      const generativeModel = this.client.getGenerativeModel({ model });

      const request: {
        contents: GeminiContent[];
        generationConfig?: GeminiGenerationConfig;
        systemInstruction?: { parts: GeminiPart[] };
      } = { contents };

      if (Object.keys(generationConfig).length > 0) {
        request.generationConfig = generationConfig;
      }

      if (systemInstruction) {
        request.systemInstruction = systemInstruction;
      }

      const sdkResult = await generativeModel.generateContent(request);
      const response = sdkResult.response;

      // Normalize response
      const candidate = response.candidates?.[0];
      const text = candidate?.content?.parts
        ?.map((part) => part.text)
        .join('') ?? '';
      const nativeStopReason = candidate?.finishReason ?? 'unknown';
      const stopReason = STOP_REASON_MAP[nativeStopReason] ?? nativeStopReason;

      // Normalize usage
      const providerResult: AIProviderResult = { text, stopReason };
      if (response.usageMetadata) {
        providerResult.usage = {
          inputTokens: response.usageMetadata.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
        };
      }

      return providerResult;
    } catch (err: unknown) {
      throw this.mapError(err);
    }
  }

  // ── Message conversion ──────────────────────────────────────────

  /**
   * Convert standard ChatMessage[] to Gemini Content[] format.
   *
   * System messages are extracted and combined into a systemInstruction.
   * User/assistant messages are mapped to Gemini's 'user'/'model' roles.
   */
  private convertMessages(
    messages: ChatMessage[],
    systemPrompt?: string,
  ): {
    contents: GeminiContent[];
    systemInstruction: { parts: GeminiPart[] } | null;
  } {
    const systemParts: string[] = [];
    const contents: GeminiContent[] = [];

    // Collect system messages
    for (const msg of messages) {
      if (msg.role === 'system') {
        systemParts.push(msg.content);
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    // Add systemPrompt from params if no system messages were found
    if (systemPrompt && systemParts.length === 0) {
      systemParts.push(systemPrompt);
    }

    const systemInstruction = systemParts.length > 0
      ? { parts: systemParts.map((text) => ({ text })) }
      : null;

    return { contents, systemInstruction };
  }

  // ── Error mapping ───────────────────────────────────────────────

  /**
   * Map Google Gemini SDK errors to typed BridgeError categories.
   *
   * The real Gemini SDK throws `GoogleGenerativeAIFetchError` with numeric
   * HTTP `status` (401, 429, etc.) and `GoogleGenerativeAIAbortError` for
   * cancellations. The mock uses string gRPC status codes ('UNAUTHENTICATED',
   * 'RESOURCE_EXHAUSTED', etc.). This method handles both.
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
    const status = error?.['status'];
    const errorName = (err as any)?.constructor?.name as string | undefined;

    // Authentication errors: HTTP 401/403 or gRPC UNAUTHENTICATED
    if (status === 401 || status === 403 || status === 'UNAUTHENTICATED' || errorName === 'AuthenticationError') {
      return BridgeError.auth(message, details, cause);
    }

    // Rate limiting: HTTP 429 or gRPC RESOURCE_EXHAUSTED
    if (status === 429 || status === 'RESOURCE_EXHAUSTED' || errorName === 'RateLimitError') {
      return new BridgeError('UPSTREAM', message, { ...details, retryable: true }, cause);
    }

    // Bad request: HTTP 400 or gRPC INVALID_ARGUMENT
    if (status === 400 || status === 'INVALID_ARGUMENT' || errorName === 'BadRequestError') {
      return new BridgeError('UPSTREAM', message, { ...details, retryable: false }, cause);
    }

    // Not found: HTTP 404 (e.g., nonexistent model)
    if (status === 404 || status === 'NOT_FOUND') {
      return new BridgeError('UPSTREAM', message, { ...details, retryable: false }, cause);
    }

    // Internal server error: HTTP 500+ or gRPC INTERNAL
    if ((typeof status === 'number' && status >= 500) || status === 'INTERNAL' || errorName === 'InternalServerError') {
      return new BridgeError('UPSTREAM', message, { ...details, retryable: true }, cause);
    }

    // Abort/cancellation errors (GoogleGenerativeAIAbortError)
    if (errorName === 'GoogleGenerativeAIAbortError') {
      return BridgeError.timeout(message, { ...details, retryable: true }, cause);
    }

    // Network/fetch errors
    if (
      errorName === 'TypeError' && message.includes('fetch') ||
      errorName === 'NetworkError' ||
      errorName === 'APIConnectionError'
    ) {
      return BridgeError.transport(message, { ...details, retryable: true }, cause);
    }

    // Timeout errors
    if (
      errorName === 'TimeoutError' ||
      errorName === 'APITimeoutError' ||
      message.toLowerCase().includes('timeout')
    ) {
      return BridgeError.timeout(message, { ...details, retryable: true }, cause);
    }

    // Default: unknown error → UPSTREAM
    return new BridgeError('UPSTREAM', message, { ...details, retryable: false }, cause);
  }
}
