/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Tool: tasks_delegate
 *
 * Fire-and-forget delegation: creates a session, sends a prompt,
 * and returns the result — all in one call.
 *
 * Semantics: convenience wrapper over sessions_create + sessions_prompt + sessions_close.
 * Use sessions_* tools directly when you need multi-turn control.
 */

import type { AgentExecutor } from '../../executor/AgentExecutor.js';
import { TasksDelegateArgsSchema } from '../../types.js';
import { mapErrorToMCP } from '../../errors/error-mapper.js';

/** Input shape for the `tasks_delegate` tool handler. */
export type TasksDelegateInput = {
  prompt: string;
  agentId?: string | undefined;
  timeout?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  runtimeParams?: Record<string, unknown> | undefined;
};

/** Optional hooks for tasks_delegate lifecycle. */
export interface TasksDelegateHooks {
  /**
   * Called after session creation but before the prompt is sent.
   * Used by McpAgenticServer to inject prompt-level runtimeParams.
   *
   * @param sessionId - The newly created session ID.
   * @param agentId - The agent ID that owns the session.
   */
  beforePrompt?: ((sessionId: string, agentId: string) => void | Promise<void>) | undefined;
}

/**
 * Handle `tasks_delegate` — one-shot delegation (create + prompt + close).
 *
 * Creates a session, sends the prompt, closes the session, and returns the result.
 * On failure, performs best-effort session cleanup.
 *
 * @param executor - Executor to delegate to.
 * @param input - Validated tool input with `prompt`, optional `agentId`, `timeout`, and `metadata`.
 * @param hooks - Optional lifecycle hooks for pre-prompt injection.
 * @returns MCP text content with the delegation result or an error payload.
 */
export async function handleTasksDelegate(
  executor: AgentExecutor,
  input: TasksDelegateInput,
  hooks?: TasksDelegateHooks,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let sessionId: string | undefined;

  try {
    TasksDelegateArgsSchema.parse(input);

    // Create session
    const session = await executor.createSession(input.agentId, input.metadata);
    sessionId = session.sessionId;

    // Invoke pre-prompt hook (e.g., inject runtimeParams)
    if (hooks?.beforePrompt) {
      await hooks.beforePrompt(sessionId, session.agentId);
    }

    // Send prompt
    const result = await executor.prompt(sessionId, input.prompt, {
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    });

    // Close session
    await executor.closeSession(sessionId, 'task-complete');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          sessionId,
          agentId: session.agentId,
          text: result.text,
          stopReason: result.stopReason,
          requestId: result.requestId,
          usage: result.usage,
        }, null, 2),
      }],
    };
  } catch (error) {
    // Best-effort cleanup
    if (sessionId) {
      await executor.closeSession(sessionId, 'task-failed').catch((cleanupErr) => {
        process.stderr.write(`[tasks_delegate] cleanup failed for session ${sessionId}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`);
      });
    }

    const mcpError = mapErrorToMCP(error);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          sessionId,
          error: mcpError.message,
          code: mcpError.code,
          data: mcpError.data,
        }, null, 2),
      }],
    };
  }
}
