/**
 * MCP Tools: sessions_*
 *
 * Full session lifecycle exposed to the MCP client.
 * The user controls their own orchestration through these tools.
 */

import type { AgentExecutor } from '../../executor/AgentExecutor.js';
import {
  SessionsCreateArgsSchema,
  SessionsPromptArgsSchema,
  SessionsStatusArgsSchema,
  SessionsCloseArgsSchema,
  SessionsCancelArgsSchema,
} from '../../types.js';
import { mapErrorToMCP } from '../../errors/error-mapper.js';

// ─── Response helper ─────────────────────────────────────────────

/** Map an error to a structured MCP error response. */
function errorResponse(error: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const mcpError = mapErrorToMCP(error);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: mcpError.message,
        code: mcpError.code,
        data: mcpError.data,
      }, null, 2),
    }],
  };
}

// ─── sessions_create ─────────────────────────────────────────────

/** Input shape for the `sessions_create` tool handler. */
export type SessionsCreateInput = {
  agentId?: string | undefined;
  workerId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/**
 * Handle `sessions_create` — create a new agent session.
 *
 * @param executor - Executor that owns the target agent.
 * @param input - Validated tool input with optional `agentId`, `workerId`, and `metadata`.
 * @returns MCP text content with session details or an error payload.
 */
export async function handleSessionsCreate(
  executor: AgentExecutor,
  input: SessionsCreateInput
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    SessionsCreateArgsSchema.parse(input);
    const agentId = input.agentId ?? input.workerId;
    const session = await executor.createSession(agentId, input.metadata);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId: session.sessionId,
          agentId: session.agentId,
          status: session.status,
          createdAt: session.createdAt,
        }, null, 2),
      }],
    };
  } catch (error) {
    return errorResponse(error);
  }
}

// ─── sessions_prompt ─────────────────────────────────────────────

/** Input shape for the `sessions_prompt` tool handler. */
export type SessionsPromptInput = {
  sessionId: string;
  prompt: string;
  timeout?: number | undefined;
};

/**
 * Handle `sessions_prompt` — send a prompt to an existing session.
 *
 * @param executor - Executor that owns the session.
 * @param input - Validated tool input with `sessionId`, `prompt`, and optional `timeout`.
 * @returns MCP text content with the agent's response or an error payload.
 */
export async function handleSessionsPrompt(
  executor: AgentExecutor,
  input: SessionsPromptInput
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    SessionsPromptArgsSchema.parse(input);
    const result = await executor.prompt(input.sessionId, input.prompt, {
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          text: result.text,
          stopReason: result.stopReason,
          requestId: result.requestId,
          usage: result.usage,
        }, null, 2),
      }],
    };
  } catch (error) {
    return errorResponse(error);
  }
}

// ─── sessions_status ─────────────────────────────────────────────

/** Input shape for the `sessions_status` tool handler. */
export type SessionsStatusInput = {
  sessionId: string;
};

/**
 * Handle `sessions_status` — check the status of an existing session.
 *
 * @param executor - Executor that owns the session.
 * @param input - Validated tool input with `sessionId`.
 * @returns MCP text content with session status or an error payload.
 */
export async function handleSessionsStatus(
  executor: AgentExecutor,
  input: SessionsStatusInput
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    SessionsStatusArgsSchema.parse(input);
    const session = await executor.getSession(input.sessionId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          sessionId: session.sessionId,
          agentId: session.agentId,
          status: session.status,
          lastActivityAt: session.lastActivityAt,
        }, null, 2),
      }],
    };
  } catch (error) {
    return errorResponse(error);
  }
}

// ─── sessions_close ──────────────────────────────────────────────

/** Input shape for the `sessions_close` tool handler. */
export type SessionsCloseInput = {
  sessionId: string;
  reason?: string | undefined;
};

/**
 * Handle `sessions_close` — close a session when done.
 *
 * @param executor - Executor that owns the session.
 * @param input - Validated tool input with `sessionId` and optional `reason`.
 * @returns MCP text content confirming closure or an error payload.
 */
export async function handleSessionsClose(
  executor: AgentExecutor,
  input: SessionsCloseInput
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    SessionsCloseArgsSchema.parse(input);
    await executor.closeSession(input.sessionId, input.reason);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ closed: true, sessionId: input.sessionId }, null, 2),
      }],
    };
  } catch (error) {
    return errorResponse(error);
  }
}

// ─── sessions_cancel ─────────────────────────────────────────────

/** Input shape for the `sessions_cancel` tool handler. */
export type SessionsCancelInput = {
  sessionId: string;
  requestId?: string | undefined;
};

/**
 * Handle `sessions_cancel` — cancel an in-flight prompt request.
 *
 * @param executor - Executor that owns the session.
 * @param input - Validated tool input with `sessionId` and optional `requestId`.
 * @returns MCP text content confirming cancellation or an error payload.
 */
export async function handleSessionsCancel(
  executor: AgentExecutor,
  input: SessionsCancelInput
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    SessionsCancelArgsSchema.parse(input);
    await executor.cancel(input.sessionId, input.requestId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ cancelled: true, sessionId: input.sessionId }, null, 2),
      }],
    };
  } catch (error) {
    return errorResponse(error);
  }
}
