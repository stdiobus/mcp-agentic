/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { AgentExecutor } from './AgentExecutor.js';
import type { AgentInfo, SessionEntry, HealthInfo } from './types.js';
import type { AgentHandler, AgentResult, AgentEvent, PromptOpts } from '../agent/AgentHandler.js';
import { BridgeError } from '../errors/BridgeError.js';

/** Configuration for {@link InProcessExecutor}. */
export interface InProcessExecutorConfig {
  /** Maximum number of concurrent sessions. Default: 100. */
  maxSessions?: number;
  /** Maximum session lifetime in milliseconds. Default: 3600000 (1 hour). */
  sessionTtlMs?: number;
  /** Maximum idle time before session expiry in milliseconds. Default: 600000 (10 minutes). */
  sessionIdleMs?: number;
  /** How often the session reaper runs in milliseconds. Default: 60000 (1 minute). */
  reaperIntervalMs?: number;
  /** When true, suppresses process.stderr.write logging. Default: false. */
  silent?: boolean;
}

/** Internal session entry with agent reference for direct dispatch. */
interface SessionEntryInternal extends SessionEntry {
  agent: AgentHandler;
}

/**
 * InProcessExecutor — runs agents directly in the server process.
 *
 * Manages session lifecycle (create, prompt, close) with TTL/idle expiry
 * and a periodic reaper. Implements the {@link AgentExecutor} interface.
 */
export class InProcessExecutor implements AgentExecutor {
  private agents = new Map<string, AgentHandler>();
  private sessions = new Map<string, SessionEntryInternal>();
  private maxSessions: number;
  private sessionTtlMs: number;
  private sessionIdleMs: number;
  private reaperIntervalMs: number;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private ready = false;
  private startedAt = 0;
  private silent: boolean;

  /**
   * @param config - Optional executor configuration. Defaults are applied for all omitted fields.
   */
  constructor(config?: InProcessExecutorConfig) {
    this.maxSessions = config?.maxSessions ?? 100;
    this.sessionTtlMs = config?.sessionTtlMs ?? 3_600_000;     // 1 hour
    this.sessionIdleMs = config?.sessionIdleMs ?? 600_000;      // 10 minutes
    this.reaperIntervalMs = config?.reaperIntervalMs ?? 60_000; // 1 minute
    this.silent = config?.silent ?? false;
  }

  /**
   * Register an in-process agent at runtime.
   *
   * @param agent - Agent implementation. Must have at least one of `prompt()` or `stream()`.
   * @throws {BridgeError} CONFIG if agent has neither `prompt()` nor `stream()`.
   */
  register(agent: AgentHandler): void {
    if (!agent.prompt && !agent.stream) {
      throw BridgeError.config(
        `Agent "${agent.id}" must implement at least one of prompt() or stream()`,
      );
    }
    this.agents.set(agent.id, agent);
  }

  // ── AgentExecutor lifecycle ───────────────────────────────────

  /**
   * Start the executor and begin the session reaper.
   * @returns Promise that resolves immediately after initialization.
   */
  async start(): Promise<void> {
    this.ready = true;
    this.startedAt = Date.now();
    this.startReaper();
    if (!this.silent) {
      process.stderr.write(`[InProcessExecutor] Started with ${this.agents.size} agents\n`);
    }
  }

  /**
   * Stop the reaper and clear all sessions.
   * @returns Promise that resolves when shutdown is complete.
   */
  async close(): Promise<void> {
    this.stopReaper();
    this.ready = false;
    const sessionCount = this.sessions.size;
    this.sessions.clear();
    if (!this.silent) {
      process.stderr.write(`[InProcessExecutor] Closed (cleared ${sessionCount} sessions)\n`);
    }
  }

  /** @returns `true` if the executor has been started. */
  isReady(): boolean {
    return this.ready;
  }

  // ── Discovery ─────────────────────────────────────────────────

  /**
   * List registered agents, optionally filtered by capability.
   *
   * @param capability - If provided, only return agents advertising this capability.
   * @returns Promise resolving to matching agent info objects.
   * @throws {BridgeError} INTERNAL if the executor is not started.
   */
  async discover(capability?: string): Promise<AgentInfo[]> {
    this.assertReady();

    const infos: AgentInfo[] = [];
    for (const agent of this.agents.values()) {
      const caps = agent.capabilities ?? [];
      if (capability === undefined || caps.includes(capability)) {
        infos.push({
          id: agent.id,
          capabilities: caps,
          status: 'ready',
        });
      }
    }
    return infos;
  }

  // ── Session management ────────────────────────────────────────

  /**
   * Create a new session bound to the specified agent.
   *
   * @param agentId - Target agent. If omitted, uses the first registered agent.
   * @param metadata - Optional caller-supplied metadata attached to the session.
   * @returns Promise resolving to the new session entry (without internal agent reference).
   * @throws {BridgeError} CONFIG if no agents are registered.
   * @throws {BridgeError} UPSTREAM if the agent is not found, capacity is reached, or `onSessionCreate` fails.
   */
  async createSession(
    agentId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<SessionEntry> {
    this.assertReady();

    if (this.agents.size === 0) {
      throw BridgeError.config('No agents registered');
    }

    const agent = this.resolveAgent(agentId);

    if (this.sessions.size >= this.maxSessions) {
      throw BridgeError.upstream('Session capacity reached');
    }

    const sessionId = randomBytes(16).toString('hex');
    const now = Date.now();

    const entry: SessionEntryInternal = {
      sessionId,
      agentId: agent.id,
      status: 'active',
      createdAt: now,
      lastActivityAt: now,
      ...(metadata !== undefined ? { metadata } : {}),
      agent,
    };

    this.sessions.set(sessionId, entry);

    if (agent.onSessionCreate) {
      try {
        await agent.onSessionCreate(sessionId, metadata);
      } catch (err) {
        // Clean up on hook failure
        this.sessions.delete(sessionId);
        throw BridgeError.upstream(
          `Agent ${agent.id} failed during onSessionCreate`,
          {},
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    return this.toPublicEntry(entry);
  }

  /**
   * Retrieve an existing session by ID.
   *
   * @param sessionId - Session to look up.
   * @returns Promise resolving to the public session entry.
   * @throws {BridgeError} UPSTREAM if the session does not exist.
   */
  async getSession(sessionId: string): Promise<SessionEntry> {
    this.assertReady();

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw BridgeError.upstream(`Session not found: ${sessionId}`);
    }
    return this.toPublicEntry(entry);
  }

  /**
   * Close a session and invoke the agent's `onSessionClose` hook.
   * Idempotent — closing an already-closed or nonexistent session is a no-op.
   *
   * @param sessionId - Session to close.
   * @param reason - Optional human-readable close reason.
   * @returns Promise that resolves when the session is removed.
   */
  async closeSession(sessionId: string, reason?: string): Promise<void> {
    this.assertReady();

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      // Idempotent: already closed or never existed
      return;
    }

    if (entry.agent.onSessionClose) {
      try {
        await entry.agent.onSessionClose(sessionId, reason);
      } catch (_err) {
        // Best-effort: log but still remove the session
      }
    }

    this.sessions.delete(sessionId);
  }

  // ── Prompting ─────────────────────────────────────────────────

  /**
   * Send a prompt to a session and return the agent's response.
   * If the agent only implements `stream()`, the stream is auto-collected into a result.
   *
   * @param sessionId - Target session.
   * @param input - Prompt text.
   * @param opts - Timeout and cancellation options.
   * @returns Promise resolving to the agent's result.
   * @throws {BridgeError} UPSTREAM if the session is not found, is busy, or the agent fails.
   * @throws {BridgeError} INTERNAL if the agent has neither `prompt()` nor `stream()`.
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

    if (entry.status === 'busy') {
      throw BridgeError.upstream(`Session ${sessionId} is busy — concurrent prompts not allowed`);
    }

    entry.status = 'busy';
    entry.lastActivityAt = Date.now();

    // Respect AbortSignal if provided
    if (opts?.signal?.aborted) {
      entry.status = 'idle';
      throw BridgeError.upstream('Request aborted before execution');
    }

    try {
      let result: AgentResult;

      if (entry.agent.prompt) {
        result = await entry.agent.prompt(sessionId, input, opts);
      } else if (entry.agent.stream) {
        result = await this.collectStream(entry.agent.stream(sessionId, input, opts));
      } else {
        throw BridgeError.internal(`Agent ${entry.agentId} has neither prompt() nor stream()`);
      }

      entry.status = 'idle';
      entry.lastActivityAt = Date.now();
      return result;
    } catch (err) {
      entry.status = 'failed';
      entry.lastActivityAt = Date.now();

      // Don't double-wrap BridgeErrors
      if (err instanceof BridgeError) throw err;

      throw BridgeError.upstream(
        `Agent ${entry.agentId} failed`,
        {},
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  // ── Cancellation ──────────────────────────────────────────────

  /**
   * Cancel an in-flight request by delegating to the agent's `cancel()` method.
   *
   * @param sessionId - Session owning the request.
   * @param requestId - Specific request to cancel.
   * @returns Promise that resolves when cancellation is acknowledged.
   * @throws {BridgeError} UPSTREAM if the session does not exist.
   */
  async cancel(sessionId: string, requestId?: string): Promise<void> {
    this.assertReady();

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw BridgeError.upstream(`Session not found: ${sessionId}`);
    }

    if (entry.agent.cancel) {
      await entry.agent.cancel(sessionId, requestId);
    }
  }

  // ── Health ────────────────────────────────────────────────────

  /**
   * Return health metrics for this executor.
   * @returns Promise resolving to health info including agent/session counts and uptime.
   */
  async health(): Promise<HealthInfo> {
    const uptime = this.ready ? Date.now() - this.startedAt : 0;
    return {
      healthy: this.ready && this.agents.size > 0,
      agents: { total: this.agents.size, ready: this.agents.size },
      sessions: { active: this.sessions.size, capacity: this.maxSessions },
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

  /** Resolve an agent by ID, or return the first registered agent if omitted. */
  private resolveAgent(agentId?: string): AgentHandler {
    if (agentId !== undefined) {
      const agent = this.agents.get(agentId);
      if (!agent) {
        throw BridgeError.upstream(`Agent not found: ${agentId}`);
      }
      return agent;
    }

    // Default: first registered agent
    const first = this.agents.values().next();
    if (first.done) {
      throw BridgeError.config('No agents registered');
    }
    return first.value as AgentHandler;
  }

  /**
   * Collect a stream into a single AgentResult.
   * Used when agent implements only stream() but caller needs prompt() semantics.
   */
  private async collectStream(stream: AsyncIterable<AgentEvent>): Promise<AgentResult> {
    let text = '';
    let finalResult: AgentResult | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case 'chunk':
          text += event.text;
          break;
        case 'final':
          finalResult = event.result;
          break;
        case 'error':
          throw new Error(event.message);
      }
    }

    if (finalResult) {
      return finalResult;
    }

    // No final event — construct result from collected chunks
    return { text, stopReason: 'end_turn' };
  }

  /** Strip the internal `agent` reference before returning to callers. */
  private toPublicEntry(entry: SessionEntryInternal): SessionEntry {
    const result: SessionEntry = {
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      status: entry.status,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
    };
    if (entry.metadata !== undefined) {
      result.metadata = entry.metadata;
    }
    return result;
  }

  // ── Session reaper ────────────────────────────────────────────

  /** Start the periodic session reaper. Timer is `unref()`'d to not block process exit. */
  private startReaper(): void {
    this.reaperTimer = setInterval(() => {
      void this.reapExpiredSessions();
    }, this.reaperIntervalMs);
    // Allow the process to exit even if the timer is still running
    if (this.reaperTimer && typeof this.reaperTimer === 'object' && 'unref' in this.reaperTimer) {
      this.reaperTimer.unref();
    }
  }

  /** Stop the periodic session reaper. */
  private stopReaper(): void {
    if (this.reaperTimer !== null) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /** Iterate sessions and remove those that exceed TTL or idle timeout. */
  private async reapExpiredSessions(): Promise<void> {
    if (!this.ready) return;
    const now = Date.now();
    const expired: SessionEntryInternal[] = [];

    for (const entry of this.sessions.values()) {
      const idleExpired = now - entry.lastActivityAt > this.sessionIdleMs;
      const ttlExpired = now - entry.createdAt > this.sessionTtlMs;
      if (idleExpired || ttlExpired) {
        expired.push(entry);
      }
    }

    for (const entry of expired) {
      this.sessions.delete(entry.sessionId);
      if (entry.agent.onSessionClose) {
        try {
          await entry.agent.onSessionClose(entry.sessionId, 'expired');
        } catch (_err) {
          // Best-effort: log but continue reaping
        }
      }
    }
  }
}
