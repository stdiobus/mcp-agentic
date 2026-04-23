/**
 * Test fixture: McpAgenticServer with deterministic in-process agents.
 *
 * Spawned as a child process by stdio e2e tests.
 * Communicates via stdio (stdin/stdout) using MCP JSON-RPC protocol.
 *
 * Usage:
 *   tsx test/e2e/fixtures/stdio-test-server.ts
 */

import { McpAgenticServer } from '../../../src/server/McpAgenticServer.js';
import type { AgentHandler, AgentResult } from '../../../src/index.js';

// ─── Deterministic test agents ───────────────────────────────────

class EchoAgent implements AgentHandler {
  readonly id = 'echo-agent';
  readonly capabilities = ['echo', 'text-processing'];
  private sessions = new Map<string, { turns: number }>();

  async onSessionCreate(sessionId: string): Promise<void> {
    this.sessions.set(sessionId, { turns: 0 });
  }

  async onSessionClose(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async prompt(sessionId: string, input: string): Promise<AgentResult> {
    const state = this.sessions.get(sessionId) ?? { turns: 0 };
    state.turns++;
    this.sessions.set(sessionId, state);
    return {
      text: `Echo[${state.turns}]: ${input}`,
      stopReason: 'end_turn',
      requestId: `req-${sessionId}-${state.turns}`,
    };
  }
}

class StatefulAgent implements AgentHandler {
  readonly id = 'stateful-agent';
  readonly capabilities = ['conversation', 'context-aware'];
  private contexts = new Map<string, { turns: number; lastInput: string }>();

  async onSessionCreate(sessionId: string): Promise<void> {
    this.contexts.set(sessionId, { turns: 0, lastInput: '' });
  }

  async onSessionClose(sessionId: string): Promise<void> {
    this.contexts.delete(sessionId);
  }

  async prompt(sessionId: string, input: string): Promise<AgentResult> {
    const ctx = this.contexts.get(sessionId) ?? { turns: 0, lastInput: '' };
    const previousInput = ctx.lastInput;
    ctx.turns++;
    ctx.lastInput = input;
    this.contexts.set(sessionId, ctx);

    const response = ctx.turns === 1
      ? `Hello! You said: "${input}". This is turn ${ctx.turns}.`
      : `Turn ${ctx.turns}. Previously: "${previousInput}". Now: "${input}".`;

    return {
      text: response,
      stopReason: 'end_turn',
      usage: { inputTokens: input.length, outputTokens: response.length },
    };
  }
}

class MathAgent implements AgentHandler {
  readonly id = 'math-agent';
  readonly capabilities = ['math', 'calculation'];

  async prompt(_sessionId: string, input: string): Promise<AgentResult> {
    const cleaned = input.replace(/[^0-9+\-*/().  ]/g, '');
    try {
      const result = Function(`"use strict"; return (${cleaned})`)();
      return { text: `Result: ${result}`, stopReason: 'end_turn' };
    } catch {
      return { text: `Error: cannot evaluate "${input}"`, stopReason: 'end_turn' };
    }
  }
}

class FailingAgent implements AgentHandler {
  readonly id = 'failing-agent';
  readonly capabilities = ['unreliable'];

  async prompt(): Promise<AgentResult> {
    throw new Error('Simulated agent failure');
  }
}

// ─── Start server ────────────────────────────────────────────────

const server = new McpAgenticServer()
  .register(new EchoAgent())
  .register(new StatefulAgent())
  .register(new MathAgent())
  .register(new FailingAgent());

const shutdown = async (): Promise<void> => {
  try { await server.close(); } catch { /* best-effort */ }
  process.exitCode = 0;
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await server.startStdio();
} catch (error) {
  process.stderr.write(`[test-server] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
