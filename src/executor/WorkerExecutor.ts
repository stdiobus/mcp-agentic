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
import type { AgentExecutor } from './AgentExecutor.js';
import type { AgentInfo, SessionEntry, HealthInfo, WorkerConfig } from './types.js';
import type { AgentResult, PromptOpts } from '../agent/AgentHandler.js';
import { BridgeError } from '../errors/BridgeError.js';

export interface WorkerExecutorConfig {
  defaultTimeout?: number; // default: 30000
  silent?: boolean; // default: false — when true, suppresses process.stderr.write logging
}

export class WorkerExecutor implements AgentExecutor {
  private workers: WorkerConfig[] = [];
  private bus: StdioBus | null = null;
  private sessions = new Map<string, SessionEntry>();
  private ready = false;
  private startedAt = 0;
  private defaultTimeout: number;
  private silent: boolean;

  constructor(config?: WorkerExecutorConfig) {
    this.defaultTimeout = config?.defaultTimeout ?? 30_000;
    this.silent = config?.silent ?? false;
  }

  /** Register a worker before start() is called. */
  addWorker(config: WorkerConfig): void {
    this.workers.push(config);
  }

  // ── AgentExecutor lifecycle ───────────────────────────────────

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
      const pools = this.workers.map((w) => ({
        id: w.id,
        command: w.command,
        args: w.args,
        instances: 1,
        ...(w.env !== undefined ? { env: w.env } : {}),
      }));

      this.bus = new StdioBus({ config: { pools } });
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

  isReady(): boolean {
    return this.ready;
  }

  // ── Discovery ─────────────────────────────────────────────────

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

  async getSession(sessionId: string): Promise<SessionEntry> {
    this.assertReady();

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw BridgeError.upstream(`Session not found: ${sessionId}`);
    }
    return { ...entry };
  }

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

  private assertReady(): void {
    if (!this.ready) {
      throw BridgeError.internal('Executor not started');
    }
  }

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
