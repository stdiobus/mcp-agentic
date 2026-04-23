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

export type TasksDelegateInput = {
  prompt: string;
  agentId?: string | undefined;
  timeout?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export async function handleTasksDelegate(
  executor: AgentExecutor,
  input: TasksDelegateInput
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let sessionId: string | undefined;

  try {
    TasksDelegateArgsSchema.parse(input);

    // Create session
    const session = await executor.createSession(input.agentId, input.metadata);
    sessionId = session.sessionId;

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
