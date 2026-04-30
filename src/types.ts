/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for MCP Agentic.
 *
 * This file contains:
 * - Logging configuration (used by observability module)
 * - MCP tool argument schemas (used by tool handlers and McpAgenticServer)
 */

import { z } from 'zod';

// ============================================================================
// Logging Configuration
// ============================================================================

/** Zod schema for structured logging configuration. */
export const LoggingConfigSchema = z.object({
  /** Minimum log level. Default: `'info'`. */
  level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Output format. Default: `'json'`. */
  format: z.enum(['json', 'pretty']).default('json'),
  /** Include ISO-8601 timestamp in log entries. Default: `true`. */
  includeTimestamp: z.boolean().default(true),
  /** Include correlation ID in log entries. Default: `true`. */
  includeCorrelationId: z.boolean().default(true),
  /**
   * Log output destination. Default: `'stderr'`.
   *
   * **Important:** `'stdout'` is intentionally excluded because stdout is
   * reserved for the MCP JSON-RPC wire protocol. Writing log data to stdout
   * corrupts the protocol stream and causes opaque "Connection closed" errors.
   */
  destination: z.enum(['stderr', 'file']).default('stderr'),
  /** File path when `destination` is `'file'`. */
  filePath: z.string().optional(),
});

/** Inferred TypeScript type for {@link LoggingConfigSchema}. */
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

// ============================================================================
// RuntimeParams Schema
// ============================================================================

/**
 * Zod schema for AI provider runtime parameters.
 *
 * Used by `sessions_prompt` and `tasks_delegate` tools to allow MCP clients
 * to dynamically override provider behavior at request time.
 *
 * Uses `.strict()` to reject unknown fields — clients must use `providerSpecific`
 * for provider-native parameters not covered by common fields.
 */
export const RuntimeParamsSchema = z.object({
  /** Model identifier to use for this request. */
  model: z.string().optional(),
  /** Sampling temperature (0–2). Higher values increase randomness. */
  temperature: z.number().min(0).max(2).optional(),
  /** Maximum number of tokens to generate. Must be a positive integer. */
  maxTokens: z.number().int().positive().optional(),
  /** Nucleus sampling probability (0–1). */
  topP: z.number().min(0).max(1).optional(),
  /** Top-K sampling parameter. Must be a positive integer. */
  topK: z.number().int().positive().optional(),
  /** Sequences that cause the model to stop generating. */
  stopSequences: z.array(z.string()).optional(),
  /** System prompt override for this request. */
  systemPrompt: z.string().optional(),
  /** Provider-specific parameters passed through to the native SDK. */
  providerSpecific: z.record(z.unknown()).optional(),
}).strict();

/** Inferred TypeScript type for {@link RuntimeParamsSchema}. */
export type RuntimeParamsInput = z.infer<typeof RuntimeParamsSchema>;

// ============================================================================
// MCP Tool Argument Schemas
// ============================================================================

/** Zod schema for `bridge_health` tool arguments (no parameters). */
export const BridgeHealthArgsSchema = z.object({});

/** Zod schema for `agents_discover` tool arguments. */
export const AgentsDiscoverArgsSchema = z.object({
  /** Filter agents by this capability string. */
  capability: z.string().optional(),
  /** Ignored; kept for backward compatibility. Default: `false`. */
  refresh: z.boolean().default(false),
});

/** Zod schema for `sessions_create` tool arguments. */
export const SessionsCreateArgsSchema = z.object({
  /** Target agent ID. If omitted, uses the default or first registered agent. */
  agentId: z.string().optional(),
  /** @deprecated Use `agentId` instead. Kept for migration compatibility. */
  workerId: z.string().optional(),
  /** Caller-supplied metadata attached to the session. */
  metadata: z.record(z.unknown()).optional(),
});

/** Zod schema for `sessions_prompt` tool arguments. */
export const SessionsPromptArgsSchema = z.object({
  /** Target session ID. */
  sessionId: z.string(),
  /** Prompt text to send to the agent. */
  prompt: z.string(),
  /** Request timeout in milliseconds. Must be a positive integer. */
  timeout: z.number().int().positive().optional(),
  /** Optional runtime parameters to override provider defaults for this prompt. */
  runtimeParams: RuntimeParamsSchema.optional(),
});

/** Zod schema for `sessions_status` tool arguments. */
export const SessionsStatusArgsSchema = z.object({
  /** Target session ID. */
  sessionId: z.string(),
});

/** Zod schema for `sessions_close` tool arguments. */
export const SessionsCloseArgsSchema = z.object({
  /** Target session ID. */
  sessionId: z.string(),
  /** Optional human-readable close reason. */
  reason: z.string().optional(),
});

/** Zod schema for `sessions_cancel` tool arguments. */
export const SessionsCancelArgsSchema = z.object({
  /** Target session ID. */
  sessionId: z.string(),
  /** Specific request to cancel. If omitted, cancels the current request. */
  requestId: z.string().optional(),
});

/** Zod schema for `tasks_delegate` tool arguments. */
export const TasksDelegateArgsSchema = z.object({
  /** Prompt text to send to the agent. */
  prompt: z.string(),
  /** Target agent ID. If omitted, uses the default or first registered agent. */
  agentId: z.string().optional(),
  /** Request timeout in milliseconds. Must be a positive integer. */
  timeout: z.number().int().positive().optional(),
  /** Caller-supplied metadata attached to the session. */
  metadata: z.record(z.unknown()).optional(),
  /** Optional runtime parameters to override provider defaults for this delegation. */
  runtimeParams: RuntimeParamsSchema.optional(),
});
