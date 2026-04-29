/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProviderKind, ProviderCapabilities } from '../provider/AIProvider.js';

/** Metadata about a registered agent returned by {@link AgentExecutor.discover}. */
export interface AgentInfo {
  /** Unique agent identifier. */
  id: string;
  /** List of capabilities this agent advertises. */
  capabilities: string[];
  /** Current availability status. */
  status: 'ready' | 'busy' | 'unavailable';
  /** AI providers available for this agent, present only when the agent supports multiple providers. */
  providers?: Array<{
    /** Unique provider identifier. */
    id: string;
    /** Model identifiers supported by this provider. */
    models: readonly string[];
    /** Type of provider (e.g., `'llm'`, `'embedding'`, `'reranker'`). Present only when the provider declares it. */
    kind?: ProviderKind;
    /** Self-reported capabilities. Present only when the provider declares non-empty capabilities. */
    capabilities?: ProviderCapabilities;
    /** Human-readable display name. Present only when the provider declares it. */
    displayName?: string;
    /** Human-readable description. Present only when the provider declares a non-empty value. */
    description?: string;
  }>;
}

/** Snapshot of a session's state returned by session management methods. */
export interface SessionEntry {
  /** Unique session identifier. */
  sessionId: string;
  /** Agent that owns this session. */
  agentId: string;
  /** Current session lifecycle status. */
  status: 'active' | 'idle' | 'busy' | 'closed' | 'failed';
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /** Unix timestamp (ms) of the last activity on this session. */
  lastActivityAt: number;
  /** Caller-supplied metadata, if provided at session creation. */
  metadata?: Record<string, unknown>;
}

/** Health metrics returned by {@link AgentExecutor.health}. */
export interface HealthInfo {
  /** Whether the executor considers itself healthy. */
  healthy: boolean;
  /** Agent count summary. */
  agents: { total: number; ready: number };
  /** Session count and capacity. */
  sessions: { active: number; capacity: number };
  /** Executor uptime in milliseconds. */
  uptime: number;
}

/** Configuration for an external ACP worker process. */
export interface WorkerConfig {
  /** Unique worker identifier, used as the agent ID for routing. */
  id: string;
  /** Executable command to spawn the worker process. */
  command: string;
  /** Command-line arguments passed to the worker process. */
  args: string[];
  /** Optional environment variables for the worker process. */
  env?: Record<string, string>;
  /** Optional list of capabilities this worker advertises. */
  capabilities?: string[];
}
