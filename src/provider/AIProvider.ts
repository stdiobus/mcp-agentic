/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AIProvider — Unified interface for AI service adapters.
 *
 * Each provider (OpenAI, Anthropic, Google Gemini, etc.) implements the
 * {@link AIProvider} interface, normalizing requests and responses to a
 * common format. This allows the rest of the system to remain agnostic
 * to the underlying AI service.
 *
 * @module provider/AIProvider
 */

// ── Message types ───────────────────────────────────────────────

// ── ContentPart discriminated union ────────────────────────────

/** A plain-text content part. */
export interface TextPart {
  readonly type: 'text';
  /** The text content of this part. */
  readonly text: string;
}

/**
 * An image URL content part.
 *
 * The optional `detail` field controls image resolution when the
 * provider supports it (e.g., OpenAI vision models).
 */
export interface ImageUrlPart {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string };
  /** Image resolution hint forwarded to providers that support it. */
  readonly detail?: 'low' | 'high' | 'original' | 'auto';
}

/**
 * A file content part.
 *
 * At least one of `file_id`, `filename`, or `file_data` must be present
 * at runtime. `file_data` is expected to be base64-encoded file content.
 */
export interface FilePart {
  readonly type: 'file';
  readonly file: {
    /** Provider-assigned file identifier (from a prior FilesAPI.create call). */
    readonly file_id?: string;
    /** Original filename; may also be a URL (e.g., `https://...`) for URL-based access. */
    readonly filename?: string;
    /** Base64-encoded file content for inline upload. */
    readonly file_data?: string;
  };
}

/** Discriminated union of all supported multimodal content parts. */
export type ContentPart = TextPart | ImageUrlPart | FilePart;

// ── ChatMessage ─────────────────────────────────────────────────

/**
 * A single message in the standard chat format used across all providers.
 *
 * The `content` field is backward-compatible: existing `string` assignments
 * continue to compile and behave identically. Pass `ContentPart[]` for
 * multimodal (image / file) messages.
 */
export interface ChatMessage {
  /** The role of the message author. */
  role: 'system' | 'user' | 'assistant';
  /**
   * The content of the message.
   *
   * - `string` — plain text (existing behavior, fully backward-compatible).
   * - `ContentPart[]` — multimodal parts (text, images, files).
   */
  content: string | ContentPart[];
}

// ── Runtime parameters ──────────────────────────────────────────

/**
 * Parameters for AI generation, passed dynamically at runtime.
 *
 * These can be specified at three levels (in ascending priority):
 * 1. `ProviderConfig.defaults` — provider-level defaults
 * 2. Session metadata `runtimeParams` — session-level overrides
 * 3. Prompt-level `runtimeParams` — per-request overrides
 *
 * Only defined fields override lower-priority values; `undefined` fields
 * are ignored during merge.
 */
export interface RuntimeParams {
  /** Model identifier to use for this request. */
  model?: string;
  /** Sampling temperature (0–2). Higher values increase randomness. */
  temperature?: number;
  /** Maximum number of tokens to generate. */
  maxTokens?: number;
  /** Nucleus sampling probability (0–1). */
  topP?: number;
  /** Top-K sampling parameter. */
  topK?: number;
  /** Sequences that cause the model to stop generating. */
  stopSequences?: string[];
  /** System prompt to use for this request. */
  systemPrompt?: string;
  /**
   * Image resolution detail hint.
   * Forwarded to providers that support it (OpenAI Chat Completions vision,
   * OpenAI Responses). Silently ignored by providers that do not support it.
   */
  detail?: 'low' | 'high' | 'original' | 'auto';
  /**
   * Provider-specific parameters not covered by common fields.
   * Unsupported keys are silently ignored by the provider.
   */
  providerSpecific?: Record<string, unknown>;
}

// ── Provider result ─────────────────────────────────────────────

/**
 * Normalized result returned by any AI provider.
 *
 * Structurally compatible with {@link AgentResult} from the agent layer.
 */
export interface AIProviderResult {
  /** The generated text response. Empty string if no content was produced. */
  text: string;
  /**
   * Why the model stopped generating.
   * Standard values: `'end_turn'`, `'max_tokens'`, `'content_filter'`.
   * Unknown native values are passed through as-is.
   */
  stopReason: string;
  /** Token usage statistics, when available from the provider. */
  usage?: {
    /** Number of input tokens consumed. */
    inputTokens: number;
    /** Number of output tokens produced. */
    outputTokens: number;
  };
}

// ── Provider configuration ──────────────────────────────────────

/**
 * Configuration for constructing a provider instance.
 *
 * Credentials are passed explicitly (sourced from environment variables
 * by the caller) — providers do not access `process.env` directly.
 */
export interface ProviderConfig {
  /**
   * Credential key-value pairs (e.g., `{ apiKey: '...' }`).
   * Sourced from environment variables by the caller.
   */
  credentials: Record<string, string>;
  /** Model identifiers available for this provider. */
  models: string[];
  /** Default RuntimeParams applied when no override is specified. */
  defaults?: RuntimeParams;
}

// ── Provider metadata types ─────────────────────────────────────

/** Type of provider for filtering and discovery. */
export type ProviderKind = 'llm' | 'embedding' | 'reranker';

/** Self-reported provider capabilities. */
export interface ProviderCapabilities {
  /** Whether the provider supports streaming responses. */
  streaming?: boolean;
  /** Whether the provider supports tool/function calling. */
  tools?: boolean;
  /** Whether the provider supports vision/image inputs. */
  vision?: boolean;
  /** Whether the provider supports structured JSON output mode. */
  jsonMode?: boolean;
  /** Whether the provider exposes a FilesAPI for server-side file management. */
  files?: boolean;
}

// ── FilesAPI types ──────────────────────────────────────────────

/**
 * Parameters for creating a provider-side file.
 *
 * Passed to {@link FilesAPI.create} to upload a file to the provider's
 * server-side file storage.
 */
export interface FileCreateParams {
  /** The filename to associate with the uploaded file. */
  readonly filename: string;
  /** File content as raw bytes or a UTF-8 string. */
  readonly content: Uint8Array | string;
  /** MIME type of the file (e.g., `'application/pdf'`, `'image/png'`). */
  readonly mimeType: string;
}

/**
 * Value object returned by a successful file upload.
 *
 * The `fileId` can be referenced in subsequent {@link FilePart} instances
 * to avoid re-uploading the same file in every request.
 */
export interface UploadedFile {
  /** Provider-assigned file identifier. */
  readonly fileId: string;
  /** Filename as stored by the provider. */
  readonly filename: string;
}

/**
 * Provider-side file management namespace.
 *
 * Present only on providers that support server-side file storage
 * (e.g., {@link OpenAIResponsesProvider}). Check `provider.files !== undefined`
 * before use.
 */
export interface FilesAPI {
  /**
   * Upload a file to the provider's file storage.
   *
   * @param params - File content and metadata.
   * @param signal - Optional AbortSignal for cooperative cancellation.
   * @returns A value object carrying the provider-assigned `fileId` and `filename`.
   * @throws {BridgeError} With category `UPSTREAM` on provider-level error.
   */
  create(params: FileCreateParams, signal?: AbortSignal): Promise<UploadedFile>;

  /**
   * Delete a previously uploaded file from the provider's file storage.
   *
   * @param fileId - The provider-assigned file identifier to delete.
   * @param signal - Optional AbortSignal for cooperative cancellation.
   * @throws {BridgeError} With category `UPSTREAM` on provider-level error.
   */
  delete(fileId: string, signal?: AbortSignal): Promise<void>;
}

// ── AIProvider interface ────────────────────────────────────────

/**
 * Unified interface for AI service adapters.
 *
 * Each concrete provider (OpenAI, Anthropic, Google Gemini) implements
 * this interface, handling SDK-specific request construction, response
 * normalization, and error mapping.
 */
export interface AIProvider {
  /** Unique provider identifier (e.g., `'openai'`, `'anthropic'`, `'google-gemini'`). */
  readonly id: string;
  /** List of model identifiers supported by this provider. */
  readonly models: readonly string[];

  /** Type of provider. Defaults to `'llm'` when not specified. */
  readonly kind?: ProviderKind;

  /** Self-reported capabilities of this provider. */
  readonly capabilities?: ProviderCapabilities;

  /**
   * Optional file management namespace.
   *
   * Present only on providers that support server-side file storage.
   * Check `provider.files !== undefined` before invoking any `FilesAPI` method.
   */
  readonly files?: FilesAPI;

  /**
   * Send a completion request to the AI service.
   *
   * @param messages - Conversation history in standard chat format.
   * @param params - Runtime parameters for this request.
   * @param signal - Optional AbortSignal for cooperative cancellation.
   * @returns Normalized provider result.
   * @throws {BridgeError} With appropriate category on failure.
   */
  complete(
    messages: ChatMessage[],
    params: RuntimeParams,
    signal?: AbortSignal,
  ): Promise<AIProviderResult>;
}

// ── RuntimeParams merge utility ─────────────────────────────────

/**
 * Merge RuntimeParams with three-level priority:
 * `configDefaults < sessionParams < promptParams`.
 *
 * - Only defined (non-undefined) fields from higher-priority layers override.
 * - `providerSpecific` is shallow-merged (spread) across all layers.
 *
 * @param configDefaults - Provider-level default parameters.
 * @param sessionParams - Session-level parameter overrides.
 * @param promptParams - Prompt-level parameter overrides (highest priority).
 * @returns Merged RuntimeParams with all layers applied.
 */
export function mergeRuntimeParams(
  configDefaults: RuntimeParams = {},
  sessionParams: RuntimeParams = {},
  promptParams: RuntimeParams = {},
): RuntimeParams {
  const merged: RuntimeParams = {};

  // Scalar fields: prompt > session > config
  const scalarKeys = [
    'model', 'temperature', 'maxTokens', 'topP', 'topK', 'stopSequences', 'systemPrompt', 'detail',
  ] as const;

  for (const key of scalarKeys) {
    const value = promptParams[key] ?? sessionParams[key] ?? configDefaults[key];
    if (value !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[key] = value;
    }
  }

  // providerSpecific: shallow merge across all layers
  const hasProviderSpecific =
    configDefaults.providerSpecific !== undefined ||
    sessionParams.providerSpecific !== undefined ||
    promptParams.providerSpecific !== undefined;

  if (hasProviderSpecific) {
    merged.providerSpecific = {
      ...configDefaults.providerSpecific,
      ...sessionParams.providerSpecific,
      ...promptParams.providerSpecific,
    };
  }

  return merged;
}
