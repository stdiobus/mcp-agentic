/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAIResponsesProvider — AI provider adapter using the OpenAI `/v1/responses` endpoint.
 *
 * Targets the Responses API exclusively — never calls `/v1/chat/completions`.
 * Supports native `input_file`, `input_image`, and `input_text` input items,
 * as well as server-side file management via the `FilesAPI` interface.
 *
 * The `openai` SDK is an optional peer dependency. Users install only the
 * SDKs they need. The provider accepts an injectable SDK constructor for
 * unit-testability without hitting the real API.
 *
 * @module provider/providers/OpenAIResponsesProvider
 */

import type {
  AIProvider,
  AIProviderResult,
  ChatMessage,
  ContentPart,
  FileCreateParams,
  FilesAPI,
  ProviderCapabilities,
  ProviderConfig,
  ProviderKind,
  RuntimeParams,
  UploadedFile,
} from '../AIProvider.js';
import { BridgeError } from '../../errors/BridgeError.js';

// ── Responses API input item types ──────────────────────────────

/**
 * Discriminated union of all Responses API input item shapes.
 *
 * Used exclusively for constructing Responses API request bodies
 * within this module. Not exported — the SDK's own types are the
 * authoritative external contract.
 */
type ResponsesInputItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: string }
  | { type: 'input_file'; file_id: string }
  | { type: 'input_file'; file_url: string }
  | { type: 'input_file'; file_data: string; filename?: string };

// ── Responses API message type ───────────────────────────────────

/**
 * Internal representation of a single message in the Responses API format.
 *
 * Content may be a plain string for simple text turns, or an array of
 * `ResponsesInputItem` for multimodal turns.
 */
interface ResponsesMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ResponsesInputItem[];
}

// ── Responses API request / response types ───────────────────────

/**
 * Parameters for the `POST /v1/responses` endpoint.
 *
 * Only the fields used by this provider are declared here.
 */
interface ResponsesCreateParams {
  model: string;
  input: ResponsesMessage[];
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  instructions?: string;
}

/**
 * Normalized shape of the Responses API response object.
 *
 * Only the fields read by this provider are declared here.
 */
interface ResponsesOutput {
  output_text?: string;
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

// ── Files API (minimal surface) ──────────────────────────────────

/**
 * Minimal surface of the OpenAI Files API used by this provider.
 */
interface OpenAIFilesAPI {
  create(
    params: { file: File; purpose: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ id: string; filename: string }>;
  delete(fileId: string, options?: { signal?: AbortSignal }): Promise<void>;
}

// ── SDK client type ──────────────────────────────────────────────

/**
 * Minimal surface of the OpenAI SDK client used by this provider.
 *
 * Only the `responses` and `files` namespaces are accessed — `chat`
 * and all other namespaces are intentionally excluded to enforce the
 * Responses-API-only contract at the type level.
 */
interface OpenAIResponsesClient {
  responses: {
    create(
      params: ResponsesCreateParams,
      options?: { signal?: AbortSignal },
    ): Promise<ResponsesOutput>;
  };
  files: OpenAIFilesAPI;
}

// ── Stop reason mapping ──────────────────────────────────────────

const STOP_REASON_MAP: Record<string, string> = {
  completed: 'end_turn',
  max_output_tokens: 'max_tokens',
  content_filter: 'content_filter',
};

// ── OpenAIResponsesProvider ──────────────────────────────────────

/**
 * OpenAI Responses API provider.
 *
 * Calls the `/v1/responses` endpoint exclusively. Use when you need
 * native `input_file` / `input_image` support without pre-uploading
 * files to a separate endpoint.
 *
 * Implements `FilesAPI` for providers that do want to pre-upload files
 * and reference them by `file_id`.
 *
 * Requires `openai` package to be installed as a peer dependency.
 * Credentials are passed via {@link ProviderConfig.credentials} — the
 * provider never accesses `process.env` directly after construction.
 *
 * @deprecated Use the `openAIResponses()` factory from `@stdiobus/mcp-agentic` instead.
 * ```ts
 * import { openAIResponses } from '@stdiobus/mcp-agentic';
 * const provider = openAIResponses({ apiKey: '...', models: ['gpt-4o'] });
 * ```
 */
export class OpenAIResponsesProvider implements AIProvider {
  readonly id = 'openai-responses';
  readonly models: readonly string[];
  readonly kind: ProviderKind = 'llm';
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    tools: false,
    vision: true,
    jsonMode: true,
    files: true,
  };

  /** FilesAPI implementation backed by OpenAI `/v1/files` endpoint. */
  readonly files: FilesAPI;

  private readonly client: OpenAIResponsesClient;
  private readonly defaults: RuntimeParams;

  /**
   * @param config - Provider configuration with credentials and model list.
   * @param openaiSDK - Optional injected SDK constructor (for testing). If not
   *   provided, the provider throws CONFIG — use `OpenAIResponsesProvider.create()`
   *   for production async construction, or `openAIResponses()` factory for the
   *   recommended synchronous declarative approach.
   * @throws {BridgeError} CONFIG if `credentials.apiKey` is missing or empty.
   * @throws {BridgeError} CONFIG if the `openai` package is not installed and
   *   no SDK constructor is injected.
   */
  constructor(
    config: ProviderConfig,
    openaiSDK?: new (opts: { apiKey: string }) => OpenAIResponsesClient,
  ) {
    const apiKey = config.credentials['apiKey'];
    if (!apiKey) {
      throw BridgeError.config(
        'OpenAI Responses provider requires "apiKey" credential',
        { providerId: 'openai-responses' },
      );
    }

    this.models = Object.freeze([...config.models]);
    this.defaults = config.defaults ?? {};

    if (openaiSDK) {
      this.client = new openaiSDK({ apiKey });
    } else {
      throw BridgeError.config(
        'OpenAI SDK ("openai" package) must be injected via constructor or use OpenAIResponsesProvider.create()',
        { providerId: 'openai-responses' },
      );
    }

    // Wire FilesAPI after client is assigned
    this.files = this.buildFilesAPI();
  }

  /**
   * Factory method that dynamically imports the OpenAI SDK.
   *
   * @deprecated Use the `openAIResponses()` factory instead. Factories are synchronous.
   * @param config - Provider configuration.
   * @returns Promise resolving to a configured OpenAIResponsesProvider instance.
   * @throws {BridgeError} CONFIG if credentials are missing or SDK is not installed.
   */
  static async create(config: ProviderConfig): Promise<OpenAIResponsesProvider> {
    try {
      // @ts-ignore — openai is an optional peer dependency; may not be installed
      const openaiModule = await import('openai');
      const OpenAI = openaiModule.default ?? openaiModule;
      return new OpenAIResponsesProvider(config, OpenAI as any);
    } catch (err: unknown) {
      if (err instanceof BridgeError) {
        throw err;
      }
      throw BridgeError.config(
        'OpenAI SDK ("openai" package) is not installed. Install it with: npm install openai',
        { providerId: 'openai-responses' },
        err instanceof Error ? err : undefined,
      );
    }
  }

  // ── AIProvider.complete ─────────────────────────────────────────

  /**
   * Send a completion request to the OpenAI Responses API (`/v1/responses`).
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

    try {
      const { input, instructions } = this.mapMessagesToInput(messages, params);

      const requestParams: ResponsesCreateParams = {
        model,
        input,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.maxTokens !== undefined ? { max_output_tokens: params.maxTokens } : {}),
        ...(params.topP !== undefined ? { top_p: params.topP } : {}),
      };

      const options: { signal?: AbortSignal } = {};
      if (signal) {
        options.signal = signal;
      }

      const response = await this.client.responses.create(requestParams, options);

      const text = response.output_text ?? '';
      const nativeStatus = response.status ?? 'unknown';
      const stopReason = STOP_REASON_MAP[nativeStatus] ?? nativeStatus;

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

  // ── Private mapping helpers ─────────────────────────────────────

  /**
   * Convert a `ChatMessage[]` to the Responses API `input[]` format.
   *
   * System messages are extracted and returned as the optional `instructions`
   * string field rather than being included in `input`. When the system
   * message content is `ContentPart[]`, only `TextPart` values are
   * concatenated.
   *
   * `params.systemPrompt` takes precedence over any system message found
   * in the conversation history.
   *
   * @param messages - Conversation history.
   * @param params - Runtime parameters (carries `systemPrompt` override).
   * @returns An object with `input` messages and an optional `instructions` string.
   */
  private mapMessagesToInput(
    messages: ChatMessage[],
    params: RuntimeParams,
  ): { input: ResponsesMessage[]; instructions?: string } {
    // Determine instructions: params.systemPrompt wins, else extract from system messages.
    let instructions: string | undefined = params.systemPrompt;

    if (instructions === undefined) {
      // Collect text from all system messages in order.
      const systemParts: string[] = [];
      for (const msg of messages) {
        if (msg.role === 'system') {
          if (typeof msg.content === 'string') {
            systemParts.push(msg.content);
          } else {
            // ContentPart[]: concatenate only TextPart values.
            for (const part of msg.content) {
              if (part.type === 'text') {
                systemParts.push(part.text);
              }
            }
          }
        }
      }
      if (systemParts.length > 0) {
        instructions = systemParts.join('\n');
      }
    }

    // Convert non-system messages to ResponsesMessage[].
    const input: ResponsesMessage[] = messages
      .filter((msg) => msg.role !== 'system')
      .map((msg): ResponsesMessage => ({
        role: msg.role as 'user' | 'assistant',
        content: this.mapContentToResponsesItems(msg.content, params),
      }));

    const result: { input: ResponsesMessage[]; instructions?: string } = { input };
    if (instructions !== undefined) {
      result.instructions = instructions;
    }
    return result;
  }

  /**
   * Convert `ChatMessage.content` (`string | ContentPart[]`) to the
   * Responses API input item representation.
   *
   * Mapping table:
   * - `string`                          → plain string (passed through as-is)
   * - `TextPart`                        → `{ type: 'input_text', text }`
   * - `ImageUrlPart`                    → `{ type: 'input_image', image_url, detail? }`
   * - `FilePart` with `file_id`         → `{ type: 'input_file', file_id }`
   * - `FilePart` with URL `filename`    → `{ type: 'input_file', file_url }`
   * - `FilePart` with `file_data`       → `{ type: 'input_file', file_data, filename? }`
   *
   * Priority for `FilePart`: `file_id` > URL `filename` > `file_data`.
   *
   * @param content - The `content` field of a `ChatMessage`.
   * @param params - Runtime parameters (carries `detail` override).
   * @returns Either a plain string or an array of `ResponsesInputItem` instances.
   */
  private mapContentToResponsesItems(
    content: string | ContentPart[],
    params: RuntimeParams,
  ): string | ResponsesInputItem[] {
    // Plain string: the Responses API accepts strings directly — no wrapping.
    if (typeof content === 'string') {
      return content;
    }

    return content.map((part): ResponsesInputItem => {
      switch (part.type) {
        case 'text':
          return { type: 'input_text', text: part.text };

        case 'image_url': {
          // Prefer detail from the part itself; fall back to params.detail.
          const detail = part.detail ?? params.detail;
          const item: ResponsesInputItem = { type: 'input_image', image_url: part.image_url.url };
          if (detail !== undefined) {
            (item as { type: 'input_image'; image_url: string; detail?: string }).detail = detail;
          }
          return item;
        }

        case 'file': {
          const { file_id, filename, file_data } = part.file;

          // Priority: file_id → URL filename → file_data.
          if (file_id !== undefined) {
            return { type: 'input_file', file_id };
          }

          if (filename !== undefined && filename.startsWith('http')) {
            return { type: 'input_file', file_url: filename };
          }

          if (file_data !== undefined) {
            const item: ResponsesInputItem = { type: 'input_file', file_data };
            if (filename !== undefined) {
              (item as { type: 'input_file'; file_data: string; filename?: string }).filename = filename;
            }
            return item;
          }

          // No usable file reference — emit an empty file item as a fallback
          // to avoid dropping the part silently. Callers must ensure at least
          // one of file_id / filename / file_data is present.
          return { type: 'input_file', file_data: '' };
        }
      }
    });
  }

  // ── FilesAPI builder ────────────────────────────────────────────

  /**
   * Construct the `FilesAPI` implementation backed by `client.files`.
   *
   * Called once in the constructor after `this.client` is assigned.
   * Both methods catch all SDK exceptions and rethrow as
   * `BridgeError.upstream()` unless the exception is already a
   * `BridgeError`.
   *
   * `Blob` and `File` are Node.js 20+ globals — no import required.
   */
  private buildFilesAPI(): FilesAPI {
    return {
      create: async (params: FileCreateParams, signal?: AbortSignal): Promise<UploadedFile> => {
        try {
          const bytes =
            params.content instanceof Uint8Array
              ? params.content
              : new TextEncoder().encode(params.content);
          const blob = new Blob([bytes], { type: params.mimeType });
          const file = new File([blob], params.filename, { type: params.mimeType });
          const createOptions: { signal?: AbortSignal } = {};
          if (signal) {
            createOptions.signal = signal;
          }
          const result = await this.client.files.create(
            { file, purpose: 'assistants' },
            createOptions,
          );
          return { fileId: result.id, filename: result.filename };
        } catch (err: unknown) {
          throw this.mapUpstreamError(err);
        }
      },

      delete: async (fileId: string, signal?: AbortSignal): Promise<void> => {
        try {
          const deleteOptions: { signal?: AbortSignal } = {};
          if (signal) {
            deleteOptions.signal = signal;
          }
          await this.client.files.delete(fileId, deleteOptions);
        } catch (err: unknown) {
          throw this.mapUpstreamError(err);
        }
      },
    };
  }

  /**
   * Map an unknown FilesAPI error to a `BridgeError` with category `UPSTREAM`.
   *
   * Unlike `mapError()` (used in `complete()`) this method does not attempt
   * full SDK error classification — FilesAPI callers care only that the error
   * is wrapped and attributed to the upstream provider.
   *
   * Pass-through: if the error is already a `BridgeError`, it is re-thrown as-is.
   *
   * @param err - The unknown error thrown by the SDK files client.
   * @returns A `BridgeError` with category `UPSTREAM`.
   */
  private mapUpstreamError(err: unknown): BridgeError {
    if (err instanceof BridgeError) {
      return err;
    }

    const error = err as Record<string, unknown>;
    const message = (error?.['message'] as string) ?? String(err);
    const cause = err instanceof Error ? err : new Error(message);

    return BridgeError.upstream(message, { providerId: this.id }, cause);
  }

  // ── Error mapping ───────────────────────────────────────────────

  /**
   * Map OpenAI SDK errors to typed `BridgeError` categories.
   *
   * Classification uses constructor name matching, which works with both
   * the real SDK and mocked error classes in tests.
   *
   * | SDK constructor name   | BridgeError category | retryable |
   * |------------------------|----------------------|-----------|
   * | `AuthenticationError`  | AUTH                 | false     |
   * | `RateLimitError`       | UPSTREAM             | true      |
   * | `APIConnectionError`   | TRANSPORT            | true      |
   * | `APITimeoutError`      | TIMEOUT              | true      |
   * | `BadRequestError`      | UPSTREAM             | false     |
   * | `InternalServerError`  | UPSTREAM             | true      |
   * | _(default)_            | UPSTREAM             | false     |
   *
   * @param err - The unknown error thrown by the SDK.
   * @returns A `BridgeError` with the appropriate category.
   */
  private mapError(err: unknown): BridgeError {
    if (err instanceof BridgeError) {
      return err;
    }

    const error = err as Record<string, unknown>;
    const message = (error?.['message'] as string) ?? String(err);
    const cause = err instanceof Error ? err : new Error(message);
    const details = { providerId: this.id };
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
