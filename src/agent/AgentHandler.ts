/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentHandler — Public interface for user-implemented agents.
 *
 * Implement at least one of `prompt` or `stream`:
 * - `prompt` — synchronous request/response
 * - `stream` — streaming chunks + final result
 * - Both — executor uses prompt for sessions_prompt, stream when streaming is requested
 *
 * If only `stream` is implemented, the executor auto-collects stream events
 * into an AgentResult for non-streaming callers.
 *
 * If only `prompt` is implemented, streaming callers get a single-chunk fallback.
 *
 * @example Prompt-only agent
 * ```ts
 * const agent: AgentHandler = {
 *   id: 'simple-agent',
 *   async prompt(sessionId, input) {
 *     return { text: `Response: ${input}`, stopReason: 'end_turn' };
 *   },
 * };
 * ```
 *
 * @example Stream-only agent
 * ```ts
 * const agent: AgentHandler = {
 *   id: 'stream-agent',
 *   async *stream(sessionId, input) {
 *     for (const word of input.split(' ')) {
 *       yield { type: 'chunk', text: word + ' ', index: 0 };
 *     }
 *     yield { type: 'final', result: { text: input, stopReason: 'end_turn' } };
 *   },
 * };
 * ```
 */

// ─── Result types ─────────────────────────────────────────────────

/** Complete result returned by an agent after processing a prompt. */
export interface AgentResult {
  /** The agent's textual response. */
  text: string;
  /** Why the agent stopped. Standard values: `'end_turn'`, `'max_turns'`, `'cancelled'`. */
  stopReason: 'end_turn' | 'max_turns' | 'cancelled' | string;
  /** Upstream request identifier, if the agent tracks one. */
  requestId?: string;
  /** Token usage statistics, when available. */
  usage?: {
    /** Number of input tokens consumed. */
    inputTokens: number;
    /** Number of output tokens produced. */
    outputTokens: number;
  };
}

/** A single text chunk emitted during streaming. */
export interface AgentChunk {
  /** Discriminator for {@link AgentEvent}. */
  type: 'chunk';
  /** Partial text content. */
  text: string;
  /** Zero-based chunk sequence index. */
  index: number;
}

/** Terminal event carrying the final result of a streaming agent. */
export interface AgentFinal {
  /** Discriminator for {@link AgentEvent}. */
  type: 'final';
  /** The complete agent result. */
  result: AgentResult;
}

/** Error event emitted during streaming. */
export interface AgentError {
  /** Discriminator for {@link AgentEvent}. */
  type: 'error';
  /** Human-readable error description. */
  message: string;
  /** Whether the caller should retry the request. */
  retryable: boolean;
}

/** Union of all events that a streaming agent can yield. */
export type AgentEvent = AgentChunk | AgentFinal | AgentError;

// ─── Options ──────────────────────────────────────────────────────

/** Options for {@link AgentHandler.prompt}. */
export interface PromptOpts {
  /** Request timeout in milliseconds. Interpretation is executor-specific. */
  timeout?: number;
  /**
   * Optional AbortSignal for cooperative cancellation.
   *
   * The executor checks `signal.aborted` at entry only. If the signal is
   * already aborted when `prompt()` is called, the request is rejected
   * immediately. During execution, cancellation is best-effort — the agent
   * implementation is responsible for checking the signal within its own
   * `prompt()` or `stream()` method.
   */
  signal?: AbortSignal;
}

/** Options for {@link AgentHandler.stream}. */
export interface StreamOpts {
  /** AbortSignal for cooperative cancellation of the stream. */
  signal?: AbortSignal;
}

// ─── AgentHandler ─────────────────────────────────────────────────

export interface AgentHandler {
  /** Unique agent identifier */
  readonly id: string;

  /** Optional list of capabilities this agent supports */
  readonly capabilities?: string[];

  /**
   * Synchronous prompt handler. Returns a complete result.
   * Optional if `stream` is implemented — executor auto-collects stream.
   *
   * @param sessionId - Session identifier from {@link AgentHandler.onSessionCreate}.
   * @param input - User prompt text.
   * @param opts - Timeout and cancellation options.
   * @returns Promise resolving to the agent's complete response.
   */
  prompt?(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult>;

  /**
   * Streaming handler. Yields chunks and a final result.
   * Optional if `prompt` is implemented — streaming callers get single-chunk fallback.
   *
   * @param sessionId - Session identifier.
   * @param input - User prompt text.
   * @param opts - Cancellation options.
   * @returns Async iterable of {@link AgentEvent} items ending with {@link AgentFinal}.
   */
  stream?(sessionId: string, input: string, opts?: StreamOpts): AsyncIterable<AgentEvent>;

  /**
   * Called when a session is created. Use to initialize per-session state.
   *
   * @param sessionId - Newly created session identifier.
   * @param metadata - Optional caller-supplied metadata for the session.
   * @returns Promise that resolves when initialization is complete.
   */
  onSessionCreate?(sessionId: string, metadata?: Record<string, unknown>): Promise<void>;

  /**
   * Called when a session is closed. Use to clean up per-session state.
   *
   * @param sessionId - Session being closed.
   * @param reason - Optional human-readable close reason (e.g. `'expired'`, `'task-complete'`).
   * @returns Promise that resolves when cleanup is complete.
   */
  onSessionClose?(sessionId: string, reason?: string): Promise<void>;

  /**
   * Cancel an in-flight request.
   *
   * @param sessionId - Session owning the request.
   * @param requestId - Specific request to cancel. If omitted, cancels the current request.
   * @returns Promise that resolves when cancellation is acknowledged.
   */
  cancel?(sessionId: string, requestId?: string): Promise<void>;
}

// ─── Alias ────────────────────────────────────────────────────────

/** Convenience alias for {@link AgentHandler}. */
export type Agent = AgentHandler;
