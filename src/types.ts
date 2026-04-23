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

export const LoggingConfigSchema = z.object({
  level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
  includeTimestamp: z.boolean().default(true),
  includeCorrelationId: z.boolean().default(true),
  destination: z.enum(['stderr', 'stdout', 'file']).default('stderr'),
  filePath: z.string().optional(),
});

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;

// ============================================================================
// MCP Tool Argument Schemas
// ============================================================================

export const BridgeHealthArgsSchema = z.object({});

export const AgentsDiscoverArgsSchema = z.object({
  capability: z.string().optional(),
  refresh: z.boolean().default(false),
});

export const SessionsCreateArgsSchema = z.object({
  agentId: z.string().optional(),
  /** @deprecated Use agentId instead. Kept for migration compatibility. */
  workerId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const SessionsPromptArgsSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  timeout: z.number().int().positive().optional(),
});

export const SessionsStatusArgsSchema = z.object({
  sessionId: z.string(),
});

export const SessionsCloseArgsSchema = z.object({
  sessionId: z.string(),
  reason: z.string().optional(),
});

export const SessionsCancelArgsSchema = z.object({
  sessionId: z.string(),
  requestId: z.string().optional(),
});

export const TasksDelegateArgsSchema = z.object({
  prompt: z.string(),
  agentId: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});
