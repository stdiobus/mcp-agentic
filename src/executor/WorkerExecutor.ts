/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkerExecutor — routes requests through @stdiobus/node StdioBus
 * to external ACP worker processes.
 *
 * Each worker is a separate process that implements the ACP protocol.
 * StdioBus handles process lifecycle (spawn, restart, drain) and
 * message routing. This executor translates AgentExecutor calls into
 * the correct StdioBus request signatures.
 *
 * Correct StdioBus API:
 *   bus.request(method, params, options)
 *
 * NOT the broken pattern from CustomAgentBridge:
 *   bus.request(agentId, { method, params })
 */

import { StdioBus } from '@stdiobus/node';
import type { StdioBusOptions, StdioBusConfig } from '@stdiobus/node';
import type { AgentExecutor } from './AgentExecutor.js';
import type { AgentInfo, SessionEntry, HealthInfo, WorkerConfig } from './types.js';
import type { AgentResult, PromptOpts } from '../agent/AgentHandler.js';
import { BridgeError } from '../errors/BridgeError.js';

/** Configuration for {@link WorkerExecutor}. */
export interface WorkerExecutorConfig {
  /** Default request timeout in milliseconds. Default: 30000. */
  defaultTimeout?: number;
  /** When true, suppresses process.stderr.write logging. Default: false. */
  silent?: boolean;
}

/**
 * WorkerExecutor — routes requests to external ACP worker processes via StdioBus.
 *
 * Implements the {@link AgentExecutor} interface. Each worker is a separate
 * child process managed by `@stdiobus/node`.
 */
export class WorkerExecutor implements AgentExecutor {
  private workers: WorkerConfig[] = [];
  private bus: StdioBus | null = null;
  private sessions = new Map<string, SessionEntry>();
  private ready = false;
  private startedAt = 0;
  private defaultTimeout: number;
  private silent: boolean;

  /**
   * @param config - Optional executor configuration.
   */
  constructor(config?: WorkerExecutorConfig) {
    this.defaultTimeout = config?.defaultTimeout ?? 30_000;
    this.silent = config?.silent ?? false;
  }

  /**
   * Register a worker configuration before `start()` is called.
   * @param config - Worker process configuration.
   */
  addWorker(config: WorkerConfig): void {
    this.workers.push(config);
  }

  // ── AgentExecutor lifecycle ───────────────────────────────────

  /**
   * Start StdioBus and spawn all registered worker processes.
   *
   * @returns Promise that resolves when all workers are running.
   * @throws {BridgeError} TRANSPORT if StdioBus fails to start.
   */
  async start(): Promise<void> {
    if (this.workers.length === 0) {
      this.ready = true;
      this.startedAt = Date.now();
      if (!this.silent) {
        process.stderr.write('[WorkerExecutor] Started (no workers)\n');
      }
      return;
    }

    try {
      const pools: StdioBusConfig['pools'] = this.workers.map((w) => ({
        id: w.id,
        command: w.command,
        args: w.args,
        instances: 1,
        // TODO: WorkerConfig.env is accepted by our public API but
        // StdioBusConfig.pools does not include `env`. When @stdiobus/node
        // adds env support to pool definitions, pass w.env here.
      }));

      // Type-checked against StdioBusOptions to catch property renames at
      // compile time. Without `satisfies`, a renamed property (e.g.
      // configJson → config) would be silently ignored at runtime, causing
      // an opaque "Connection closed" crash on the MCP client side.
      const busOptions = { config: { pools } } satisfies StdioBusOptions;

      this.bus = new StdioBus(busOptions);
      await this.bus.start();

      this.ready = true;
      this.startedAt = Date.now();
      if (!this.silent) {
        process.stderr.write(`[WorkerExecutor] Started with ${this.workers.length} workers\n`);
      }
    } catch (err) {
      if (!this.silent) {
        process.stderr.write(`[WorkerExecutor] Failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      throw BridgeError.transport(
        'Failed to start StdioBus',
        { retryable: false },
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /**
   * Stop StdioBus and clear all tracked sessions.
   * @returns Promise that resolves when shutdown is complete.
   */
  async close(): Promise<void> {
    this.ready = false;

    if (this.bus) {
      try {
        await this.bus.stop();
      } catch (_err) {
        // Best-effort stop
      }
      this.bus = null;
    }

    this.sessions.clear();
  }

  /** @returns `true` if the executor has been started. */
  isReady(): boolean {
    return this.ready;
  }

  // ── Discovery ─────────────────────────────────────────────────

  /**
   * List registered workers as agent info, optionally filtered by capability.
   *
   * @param capability - If provided, only return workers advertising this capability.
   * @returns Promise resolving to matching agent info objects.
   */
  async discover(capability?: string): Promise<AgentInfo[]> {
    this.assertReady();

    const infos: AgentInfo[] = this.workers.map((w) => ({
      id: w.id,
      capabilities: w.capabilities ?? [],
      status: 'ready' as const,
    }));

    return capability
      ? infos.filter((a) => a.capabilities.includes(capability))
      : infos;
  }

  // ── Session management ────────────────────────────────────────

  /**
   * Create a new session on the target worker via StdioBus.
   *
   * @param agentId - Target worker ID. If omitted, uses the first registered worker.
   * @param metadata - Optional caller-supplied metadata attached to the session.
   * @returns Promise resolving to the new session entry.
   * @throws {BridgeError} UPSTREAM if the worker is not found or returns an invalid response.
   */
  async createSession(
    agentId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SessionEntry> {
    this.assertReady();

    const worker = this.resolveWorker(agentId);
    const timeout = this.defaultTimeout;

    try {
      const result = await this.busRequest<{ sessionId: string }>(
        'session/new',
        { agentId: worker.id },
        { timeout },
      );

      // Validate worker response contains a non-empty sessionId string
      if (
        result == null ||
        typeof result.sessionId !== 'string' ||
        result.sessionId.length === 0
      ) {
        throw BridgeError.upstream('Invalid worker response: missing sessionId');
      }

      const now = Date.now();
      const entry: SessionEntry = {
        sessionId: result.sessionId,
        agentId: worker.id,
        status: 'active',
        createdAt: now,
        lastActivityAt: now,
        ...(metadata !== undefined ? { metadata } : {}),
      };

      this.sessions.set(result.sessionId, entry);
      return entry;
    } catch (err) {
      throw this.wrapBusError(err, worker.id, 'createSession');
    }
  }

  /**
   * Retrieve a locally tracked session by ID.
   *
   * @param sessionId - Session to look up.
   * @returns Promise resolving to a copy of the session entry.
   * @throws {BridgeError} UPSTREAM if the session does not exist.
   */
  async getSession(sessionId: string): Promise<SessionEntry> {
    this.assertReady();

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw BridgeError.upstream(`Session not found: ${sessionId}`);
    }
    return { ...entry };
  }

  /**
   * Close a session on the worker and remove it from local tracking.
   * Idempotent — closing an already-closed session is a no-op.
   *
   * @param sessionId - Session to close.
   * @param _reason - Unused; kept for interface compatibility.
   * @returns Promise that resolves when the session is closed.
   * @throws {BridgeError} UPSTREAM or TRANSPORT if the worker request fails.
   */
  async closeSession(sessionId: string, _reason?: string): Promise<void> {
    this.assertReady();

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      // Idempotent: already closed
      return;
    }

    try {
      await this.busRequest(
        'session/close',
        { sessionId },
        { timeout: this.defaultTimeout },
      );
    } catch (err) {
      throw this.wrapBusError(err, entry.agentId, 'closeSession');
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  // ── Prompting ─────────────────────────────────────────────────

  /**
   * Send a prompt to a worker session and return the result.
   *
   * @param sessionId - Target session.
   * @param input - Prompt text.
   * @param opts - Timeout options.
   * @returns Promise resolving to the agent's result.
   * @throws {BridgeError} UPSTREAM if the session is not found or the worker returns a malformed response.
   * @throws {BridgeError} TRANSPORT (retryable) if the worker times out.
   */
  async prompt(
    sessionId: string,
    input: string,
    opts?: PromptOpts,
  ): Promise<AgentResult> {
    this.assertReady();

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw BridgeError.upstream(`Session not found: ${sessionId}`);
    }

    entry.status = 'busy';
    entry.lastActivityAt = Date.now();

    const timeout = opts?.timeout ?? this.defaultTimeout;

    try {
      const result = await this.busRequest<AgentResult>(
        'session/prompt',
        { sessionId, input },
        { timeout },
      );

      // Validate worker response contains text (string) and stopReason (string)
      if (
        result == null ||
        typeof result.text !== 'string' ||
        typeof result.stopReason !== 'string'
      ) {
        throw BridgeError.upstream('Invalid worker response: malformed prompt result');
      }

      entry.status = 'idle';
      entry.lastActivityAt = Date.now();

      return {
        text: result.text,
        stopReason: result.stopReason,
        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      };
    } catch (err) {
      entry.status = 'failed';
      entry.lastActivityAt = Date.now();
      throw this.wrapBusError(err, entry.agentId, 'prompt');
    }
  }

  // ── Cancellation ──────────────────────────────────────────────

  /**
   * Cancel an in-flight request on the worker. Best-effort — errors are swallowed.
   *
   * @param sessionId - Session owning the request.
   * @param _requestId - Unused; kept for interface compatibility.
   * @returns Promise that resolves when cancellation is attempted.
   * @throws {BridgeError} UPSTREAM if the session does not exist.
   */
  async cancel(sessionId: string, _requestId?: string): Promise<void> {
    this.assertReady();

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw BridgeError.upstream(`Session not found: ${sessionId}`);
    }

    try {
      await this.busRequest(
        'session/cancel',
        { sessionId },
        { timeout: this.defaultTimeout },
      );
    } catch (_err) {
      // Best-effort cancel
    }
  }

  // ── Health ────────────────────────────────────────────────────

  /**
   * Return health metrics for this executor.
   * @returns Promise resolving to health info including worker/session counts and uptime.
   */
  async health(): Promise<HealthInfo> {
    const uptime = this.ready ? Date.now() - this.startedAt : 0;
    return {
      healthy: this.ready && this.workers.length > 0,
      agents: {
        total: this.workers.length,
        ready: this.bus ? this.workers.length : 0,
      },
      sessions: {
        active: this.sessions.size,
        capacity: 1000, // Workers manage their own capacity
      },
      uptime,
    };
  }

  // ── Private helpers ───────────────────────────────────────────

  /** Assert the executor is started; throw INTERNAL if not. */
  private assertReady(): void {
    if (!this.ready) {
      throw BridgeError.internal('Executor not started');
    }
  }

  /** Resolve a worker by ID, or return the first registered worker if omitted. */
  private resolveWorker(agentId?: string): WorkerConfig {
    if (agentId !== undefined) {
      const worker = this.workers.find((w) => w.id === agentId);
      if (!worker) {
        throw BridgeError.upstream(`Worker not found: ${agentId}`);
      }
      return worker;
    }

    // Default: first registered worker
    if (this.workers.length === 0) {
      throw BridgeError.upstream('No workers registered');
    }
    return this.workers[0]!;
  }

  /**
   * Send a request through StdioBus using the CORRECT signature:
   *   bus.request(method, params, options)
   */
  private async busRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    options: { timeout?: number },
  ): Promise<T> {
    if (!this.bus) {
      throw BridgeError.internal('StdioBus not initialized');
    }
    return this.bus.request<T>(method, params, options);
  }

  /**
   * Wrap a bus error into the appropriate BridgeError type.
   * Timeout errors → BridgeError.transport (retryable: true)
   * Other errors  → BridgeError.upstream with context
   */
  private wrapBusError(err: unknown, workerId: string, operation: string): BridgeError {
    // If already a BridgeError (e.g. from response validation), pass through
    if (err instanceof BridgeError) {
      return err;
    }

    const cause = err instanceof Error ? err : new Error(String(err));
    const message = cause.message.toLowerCase();

    if (message.includes('timeout') || message.includes('timed out')) {
      return BridgeError.transport(
        `Worker ${workerId} timed out: ${operation}`,
        { retryable: true },
        cause,
      );
    }

    return BridgeError.upstream(
      `Worker ${workerId} failed: ${operation}`,
      {},
      cause,
    );
  }
}
