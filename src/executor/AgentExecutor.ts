/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentInfo, SessionEntry, HealthInfo } from './types.js';
import type { AgentResult, PromptOpts } from '../agent/AgentHandler.js';

/**
 * Internal abstraction over execution backends.
 *
 * Tool handlers depend only on this interface, not on concrete executors.
 * Two implementations exist: {@link InProcessExecutor} and {@link WorkerExecutor}.
 */
export interface AgentExecutor {
  /**
   * Initialize the executor and make it ready to accept requests.
   * @returns Promise that resolves when the executor is ready.
   */
  start(): Promise<void>;

  /**
   * Shut down the executor and release all resources.
   * @returns Promise that resolves when shutdown is complete.
   */
  close(): Promise<void>;

  /**
   * Whether the executor has been started and is accepting requests.
   * @returns `true` if the executor is ready.
   */
  isReady(): boolean;

  /**
   * List available agents, optionally filtered by capability.
   *
   * @param capability - If provided, only return agents with this capability.
   * @returns Promise resolving to an array of agent info objects.
   */
  discover(capability?: string): Promise<AgentInfo[]>;

  /**
   * Create a new session for the given agent.
   *
   * @param agentId - Target agent. If omitted, uses the first registered agent.
   * @param metadata - Optional caller-supplied metadata attached to the session.
   * @returns Promise resolving to the new session entry.
   * @throws {BridgeError} CONFIG if no agents are registered.
   * @throws {BridgeError} UPSTREAM if the agent is not found or capacity is reached.
   */
  createSession(agentId?: string, metadata?: Record<string, unknown>): Promise<SessionEntry>;

  /**
   * Retrieve an existing session by ID.
   *
   * @param sessionId - Session to look up.
   * @returns Promise resolving to the session entry.
   * @throws {BridgeError} UPSTREAM if the session does not exist.
   */
  getSession(sessionId: string): Promise<SessionEntry>;

  /**
   * Close a session and release its resources.
   *
   * @param sessionId - Session to close. Idempotent if already closed.
   * @param reason - Optional human-readable close reason.
   * @returns Promise that resolves when the session is closed.
   */
  closeSession(sessionId: string, reason?: string): Promise<void>;

  /**
   * Send a prompt to a session and return the agent's response.
   *
   * @param sessionId - Target session.
   * @param input - Prompt text.
   * @param opts - Timeout and cancellation options.
   * @returns Promise resolving to the agent's result.
   * @throws {BridgeError} UPSTREAM if the session is not found or is busy.
   */
  prompt(sessionId: string, input: string, opts?: PromptOpts): Promise<AgentResult>;

  /**
   * Cancel an in-flight prompt request.
   *
   * @param sessionId - Session owning the request.
   * @param requestId - Specific request to cancel. If omitted, cancels the current request.
   * @returns Promise that resolves when cancellation is acknowledged.
   * @throws {BridgeError} UPSTREAM if the session does not exist.
   */
  cancel(sessionId: string, requestId?: string): Promise<void>;

  /**
   * Return health information for this executor.
   * @returns Promise resolving to health metrics.
   */
  health(): Promise<HealthInfo>;
}
