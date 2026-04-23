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

export interface AgentResult {
  text: string;
  stopReason: 'end_turn' | 'max_turns' | 'cancelled' | string;
  requestId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgentChunk {
  type: 'chunk';
  text: string;
  index: number;
}

export interface AgentFinal {
  type: 'final';
  result: AgentResult;
}

export interface AgentError {
  type: 'error';
  message: string;
  retryable: boolean;
}

export type AgentEvent = AgentChunk | AgentFinal | AgentError;

// ─── Options ──────────────────────────────────────────────────────

export interface PromptOpts {
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

export interface StreamOpts {
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
   */
  prompt?(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult>;

  /**
   * Streaming handler. Yields chunks and a final result.
   * Optional if `prompt` is implemented — streaming callers get single-chunk fallback.
   */
  stream?(sessionId: string, input: string, opts?: StreamOpts): AsyncIterable<AgentEvent>;

  /**
   * Called when a session is created. Use to initialize per-session state.
   */
  onSessionCreate?(sessionId: string, metadata?: Record<string, unknown>): Promise<void>;

  /**
   * Called when a session is closed. Use to clean up per-session state.
   */
  onSessionClose?(sessionId: string, reason?: string): Promise<void>;

  /**
   * Cancel an in-flight request.
   */
  cancel?(sessionId: string, requestId?: string): Promise<void>;
}

// ─── Alias ────────────────────────────────────────────────────────

export type Agent = AgentHandler;
