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

/** A single message in the standard chat format used across all providers. */
export interface ChatMessage {
  /** The role of the message author. */
  role: 'system' | 'user' | 'assistant';
  /** The textual content of the message. */
  content: string;
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
    'model', 'temperature', 'maxTokens', 'topP', 'topK', 'stopSequences', 'systemPrompt',
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
