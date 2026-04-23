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

export type SessionsCreateInput = {
  agentId?: string | undefined;
  workerId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

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

export type SessionsPromptInput = {
  sessionId: string;
  prompt: string;
  timeout?: number | undefined;
};

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

export type SessionsStatusInput = {
  sessionId: string;
};

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

export type SessionsCloseInput = {
  sessionId: string;
  reason?: string | undefined;
};

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

export type SessionsCancelInput = {
  sessionId: string;
  requestId?: string | undefined;
};

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
