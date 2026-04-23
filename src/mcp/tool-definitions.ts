/**
 * Centralized tool definitions — single source of truth for tool metadata.
 *
 * Each entry pairs a tool name with its description and a JSON Schema
 * `inputSchema` generated from the Zod schemas in `../types.ts`.
 *
 * McpAgenticServer imports TOOL_DEFINITIONS to register tools on the MCP
 * server, and tests can verify the generated schemas independently.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { JsonSchema7Type } from 'zod-to-json-schema';

import {
  AgentsDiscoverArgsSchema,
  SessionsCreateArgsSchema,
  SessionsPromptArgsSchema,
  SessionsStatusArgsSchema,
  SessionsCloseArgsSchema,
  SessionsCancelArgsSchema,
  TasksDelegateArgsSchema,
} from '../types.js';

// ─── Types ───────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: JsonSchema7Type;
}

// ─── Individual tool definitions ─────────────────────────────────
// @note: extend by external UI/CLI management as well.
//        This approach allows user to control its own flow completely.

export const bridgeHealthDef: ToolDefinition = {
  name: 'bridge_health',
  description:
    'Check bridge readiness. Use when availability is uncertain before delegating',
  // bridge_health has no input parameters — schema omitted
};

export const agentsDiscoverDef: ToolDefinition = {
  name: 'agents_discover',
  description:
    'List available agents. Filter by capability to find the right agent for your task.',
  inputSchema: zodToJsonSchema(AgentsDiscoverArgsSchema, { target: 'jsonSchema7' }),
};

export const sessionsCreateDef: ToolDefinition = {
  name: 'sessions_create',
  description:
    'Create a new agent session. Returns a sessionId for subsequent calls.',
  inputSchema: zodToJsonSchema(SessionsCreateArgsSchema, { target: 'jsonSchema7' }),
};

export const sessionsPromptDef: ToolDefinition = {
  name: 'sessions_prompt',
  description:
    'Send a prompt to an existing session and get the agent response.',
  inputSchema: zodToJsonSchema(SessionsPromptArgsSchema, { target: 'jsonSchema7' }),
};

export const sessionsStatusDef: ToolDefinition = {
  name: 'sessions_status',
  description: 'Check the status of an existing session.',
  inputSchema: zodToJsonSchema(SessionsStatusArgsSchema, { target: 'jsonSchema7' }),
};

export const sessionsCloseDef: ToolDefinition = {
  name: 'sessions_close',
  description:
    'Close a session when done. Always close sessions you no longer need.',
  inputSchema: zodToJsonSchema(SessionsCloseArgsSchema, { target: 'jsonSchema7' }),
};

export const sessionsCancelDef: ToolDefinition = {
  name: 'sessions_cancel',
  description: 'Cancel an in-flight prompt request.',
  inputSchema: zodToJsonSchema(SessionsCancelArgsSchema, { target: 'jsonSchema7' }),
};

export const tasksDelegateDef: ToolDefinition = {
  name: 'tasks_delegate',
  description:
    'Delegate a task to an agent in one call (create session + prompt + close). Use sessions_* tools for multi-turn conversations.',
  inputSchema: zodToJsonSchema(TasksDelegateArgsSchema, { target: 'jsonSchema7' }),
};

// ─── Aggregated array ────────────────────────────────────────────

/**
 * All tool definitions in registration order.
 * Used by McpAgenticServer for tool registration and by tests for
 * schema verification.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  bridgeHealthDef,
  agentsDiscoverDef,
  sessionsCreateDef,
  sessionsPromptDef,
  sessionsStatusDef,
  sessionsCloseDef,
  sessionsCancelDef,
  tasksDelegateDef,
] as const;
